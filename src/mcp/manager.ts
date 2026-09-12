import type { EventLog } from "../events/log";
import type { ToolRegistry } from "../tools/registry";
import { McpTool } from "./tool";
import type {
  ClientFactory,
  McpConnection,
  McpServerStatus,
  McpToolDef,
  NamedServerConfig,
} from "./types";

export interface McpManagerOptions {
  servers: NamedServerConfig[];
  factory: ClientFactory;
  log: EventLog;
  /** Per-server connect+list timeout in ms. */
  timeoutMs: number;
}

interface ConnectedServer {
  name: string;
  conn: McpConnection;
  tools: McpToolDef[];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class McpManager {
  private connected: ConnectedServer[] = [];
  private statuses: McpServerStatus[] = [];

  constructor(private readonly opts: McpManagerOptions) {}

  async connectAll(): Promise<void> {
    const { servers, factory, log, timeoutMs } = this.opts;
    await Promise.all(
      servers.map(async (s) => {
        if (!s.enabled) {
          this.statuses.push({ name: s.name, state: "disabled", toolCount: 0, toolNames: [] });
          return;
        }
        const conn = factory(s);
        try {
          const tools = await withTimeout(
            conn.connect().then(() => conn.listTools()),
            timeoutMs,
          );
          this.connected.push({ name: s.name, conn, tools });
          const toolNames = tools.map((t) => `mcp__${s.name}__${t.name}`);
          this.statuses.push({
            name: s.name,
            state: "connected",
            toolCount: tools.length,
            toolNames,
          });
          log.append({
            sessionId: "",
            type: "mcp_server_connected",
            payload: { name: s.name, toolCount: tools.length },
          });
        } catch (e) {
          await conn.close().catch(() => {});
          const error = e instanceof Error ? e.message : String(e);
          this.statuses.push({ name: s.name, state: "failed", toolCount: 0, toolNames: [], error });
          log.append({
            sessionId: "",
            type: "mcp_server_failed",
            payload: { name: s.name, error },
          });
          console.error(`[cleetus] WARNING: MCP server '${s.name}' failed to connect: ${error}`);
        }
      }),
    );
  }

  registerInto(registry: ToolRegistry): void {
    for (const server of this.connected) {
      for (const def of server.tools) {
        registry.register(new McpTool(server.name, def, server.conn));
      }
    }
  }

  status(): McpServerStatus[] {
    return this.statuses;
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.connected.map((s) => s.conn.close().catch(() => {})));
    this.connected = [];
  }
}
