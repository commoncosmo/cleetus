import { isEventVisible } from "../events/types";

/** The subset of an events/types `Event` the bridge reads. Widened from `Event` so callers (and
 *  the unit test) may pass synthetic events whose `type` is an arbitrary string. */
type BridgeEvent = { type: string; payload: unknown };

const TOOL_KIND: Record<string, string> = {
  read_file: "read",
  glob: "search",
  grep: "search",
  code_search: "search",
  write_file: "edit",
  edit_file: "edit",
  multi_edit: "edit",
  apply_patch: "edit",
  bash: "execute",
  run_tests: "execute",
  smoke_run: "execute",
  web_fetch: "fetch",
  web_search: "fetch",
};

export function toolKind(toolName: string): string {
  return TOOL_KIND[toolName] ?? "other";
}

/** Map a cleetus runtime event to the inner ACP `update` object (keyed by `sessionUpdate`),
 *  or null when the event has no ACP analog. The caller wraps it as
 *  `{ sessionId, update }` for the `session/update` notification.
 *
 *  Tool events come in two payload shapes: the real runtime emits `{ call: ToolCall }`
 *  (start) and `{ call, ...ToolResult }` (end); this bridge also accepts the flat
 *  `{ id, tool, summary }` / `{ id, ok, output }` shape for direct construction. */
export function eventToUpdate(event: BridgeEvent, verbose = false): object | null {
  if (!isEventVisible(event, verbose)) return null;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const call = (p.call ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "model_call_chunk":
      return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: String(p.text ?? "") },
      };
    case "reasoning_chunk":
      return {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: String(p.text ?? "") },
      };
    case "tool_call_start": {
      const id = String(call.id ?? p.id ?? "");
      const name = String(call.name ?? p.tool ?? "");
      return {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: String(p.summary ?? name),
        kind: toolKind(name),
        status: "in_progress",
      };
    }
    case "tool_call_end": {
      const id = String(call.id ?? p.id ?? "");
      const failed = p.ok === false;
      const text =
        p.output != null
          ? String(p.output)
          : p.errorMessage != null
            ? String(p.errorMessage)
            : undefined;
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: failed ? "failed" : "completed",
        content: text != null ? [{ type: "content", content: { type: "text", text } }] : undefined,
      };
    }
    case "notice":
      return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: String(p.text ?? "") },
      };
    case "assistant_message":
      // Normal assistant text was already streamed as model_call_chunk events. Only synthetic
      // terminal stop messages need bridging; otherwise the client would render every answer twice.
      return p.stoppedReason
        ? {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: String(p.text ?? "") },
          }
        : null;
    case "model_call_start":
      // ACP v1 has no model-call session update. Emitting a proprietary discriminator here makes
      // strict clients such as Zed reject the entire notification as invalid params.
      return null;
    default:
      return null;
  }
}

/** Return true when `event` is a structured runtime stop caused by the loop-limit or the stream
 *  watchdog. Both paths in `src/agent/runtime.ts` emit an `assistant_message` event whose payload
 *  carries `stoppedReason: "loop_limit" | "stream_watchdog"`. Cancellation (`"cancelled"`) is
 *  excluded — it is already tracked via the AbortSignal and maps to `"cancelled"`, not
 *  `"max_turn_requests"`. A plain `notice` event (which the old regex matched) is NOT a cap-stop;
 *  only the structured `stoppedReason` field on `assistant_message` is authoritative. */
export function isCapStop(event: BridgeEvent): boolean {
  if (event.type !== "assistant_message") return false;
  const reason = (event.payload as Record<string, unknown> | null)?.stoppedReason;
  return reason === "loop_limit" || reason === "stream_watchdog";
}

/** Derive the ACP turn stopReason. `RunTurnResult` is `{ assistantText, toolCalls }` — it carries
 *  NO stop field, so the adapter tracks two signals during the turn: whether the AbortSignal fired
 *  (`cancelled` — wins), whether a loop-cap / watchdog structured stop fired
 *  (`max_turn_requests`), and whether the runtime ended on an internal turn failure (`refusal`). */
export function deriveStopReason(signals: {
  aborted?: boolean;
  capped?: boolean;
  failed?: boolean;
}): string {
  if (signals.aborted) return "cancelled";
  if (signals.capped) return "max_turn_requests";
  if (signals.failed) return "refusal";
  return "end_turn";
}
