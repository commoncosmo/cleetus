import type { ChatOptions } from "./types";

/** The tool-call envelope schema for constrained corrective retries (WS4). Deliberately tiny:
 *  `arguments` is a generic object — never an anyOf of full tool schemas (grammar compilation
 *  on llama.cpp-based servers scales badly with schema size, and validateToolArgs gates
 *  argument shape after parsing). All-required + additionalProperties:false for OpenAI
 *  strict-mode compatibility. */
export function toolCallEnvelope(
  toolNames: string[],
): NonNullable<ChatOptions["responseFormat"]> | undefined {
  // An empty enum is invalid JSON Schema and rejected by strict backends; no tools means
  // there is nothing to constrain toward.
  if (toolNames.length === 0) return undefined;
  return {
    name: "tool_call",
    kind: "tool-call",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", enum: toolNames },
        arguments: { type: "object" },
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    },
  };
}

/** Parse a constrained completion's content as the tool-call envelope. Null on any mismatch —
 *  callers fall through to the regex-recovery ladder. Pure. */
export function parseToolCallEnvelope(
  content: string,
): { name: string; args: Record<string, unknown> } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content.trim());
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  if (typeof o.arguments !== "object" || o.arguments === null || Array.isArray(o.arguments)) {
    return null;
  }
  return { name: o.name, args: o.arguments as Record<string, unknown> };
}

/** True when a provider error is a 4xx rejecting the `response_format` field itself — the
 *  server does not support constrained decoding. Deliberately narrow: 5xx (server faults)
 *  and unrelated 4xx must NOT memoize. Matches `describeError`'s `(status) message` format
 *  in openai-compat.ts (e.g. "chat request failed (400) unknown field: response_format"). */
export function isNoResponseFormatError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message.toLowerCase();
  const is4xx = /\((4\d\d)\)/.test(m);
  return (
    is4xx &&
    (m.includes("response_format") || m.includes("json_schema") || m.includes("structured output"))
  );
}

/** True for content that is a cut-off JSON object — starts an object but does not parse.
 *  Used to suppress the WS4 late-flush: a server honoring response_format that hit the token
 *  limit emits half an envelope, which must not be shown as prose. Legit prose answers from
 *  servers that IGNORED response_format do not look like this. Pure. */
export function looksLikeTruncatedJson(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith("{")) return false;
  try {
    JSON.parse(t);
    return false;
  } catch {
    return true;
  }
}

/** Per-provider-name memo for "this server rejects response_format" (WS4 attempt-and-memoize).
 *  One instance per decision scope — the runtime and the orchestrator's callModel deliberately
 *  hold SEPARATE instances so one scope's memoization never disables the other's retries. */
export class NoResponseFormatMemo {
  private readonly names = new Set<string>();
  has(name: string): boolean {
    return this.names.has(name);
  }
  add(name: string): void {
    this.names.add(name);
  }
}
