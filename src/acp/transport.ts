import {
  JSONRPC_INTERNAL,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  type JsonRpcId,
  type JsonRpcResponse,
} from "./jsonrpc";

export type MethodHandler = (params: unknown) => Promise<unknown>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Client-directed ACP requests include permission prompts and filesystem/terminal operations.
 *  A client disappearing without closing stdin must not strand a Cleetus turn forever. */
export const ACP_CLIENT_REQUEST_TIMEOUT_MS = 5 * 60_000;

/** Newline-delimited JSON-RPC 2.0 peer over an injected `write` sink. Serves inbound requests
 *  registered via `onRequest`, and issues outbound requests/notifications. The caller pumps
 *  inbound lines through `handleLine`. A single malformed or unknown message never throws out
 *  of `handleLine` — it produces a JSON-RPC error response (for requests) or is ignored. */
export class AcpTransport {
  private readonly handlers = new Map<string, MethodHandler>();
  private readonly pending = new Map<JsonRpcId, Pending>();
  private nextId = 1;

  constructor(
    private readonly opts: { write: (line: string) => void; requestTimeoutMs?: number },
  ) {}

  onRequest(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = this.opts.requestTimeoutMs ?? ACP_CLIENT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`ACP client request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let msg: {
      id?: JsonRpcId;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.send(this.errorResponse(null, JSONRPC_PARSE_ERROR, "Parse error"));
      return;
    }
    // A response to one of our outbound requests (has id, no method).
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method !== "string") return; // not a valid request/notification
    const handler = this.handlers.get(msg.method);
    if (msg.id === undefined) {
      // Notification: best-effort, no response, swallow handler errors.
      if (handler) await handler(msg.params).catch(() => {});
      return;
    }
    if (!handler) {
      this.send(
        this.errorResponse(msg.id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${msg.method}`),
      );
      return;
    }
    try {
      const result = await handler(msg.params);
      this.send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      this.send(
        this.errorResponse(msg.id, JSONRPC_INTERNAL, e instanceof Error ? e.message : String(e)),
      );
    }
  }

  private errorResponse(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
    // JSON-RPC 2.0 §5: when the request id cannot be determined (e.g. a parse error), `id` MUST
    // be null rather than an arbitrary sentinel value such as 0.
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
  }

  private send(obj: unknown): void {
    const line = JSON.stringify(obj);
    if (line.includes("\n")) throw new Error("ACP message contained an embedded newline");
    this.opts.write(`${line}\n`);
  }
}
