export type EventType =
  | "session_start"
  | "session_end"
  | "user_input"
  | "workflow_command"
  | "workflow_status"
  | "workflow_result"
  | "editor_audit"
  | "model_call_start"
  | "model_call_chunk"
  | "model_call_end"
  | "tool_call_request"
  | "permission_request"
  | "permission_decision"
  | "tool_call_start"
  | "tool_call_end"
  | "assistant_message"
  | "reasoning"
  | "reasoning_chunk"
  | "notice"
  | "compaction_start"
  | "compaction_end"
  | "todo_restore"
  | "diagnostics"
  | "hook_run"
  | "turn_reverted"
  | "mcp_server_connected"
  | "mcp_server_failed"
  | "error";

export interface EventInput {
  sessionId: string;
  type: EventType;
  payload: unknown;
}

export interface Event extends EventInput {
  id: string;
  ts: number;
}

export type EventListener = (event: Event) => void;

/** Whether an event belongs in the user-facing stream at the selected verbosity. Warning-level
 * notices are operational diagnostics, not task results, so normal output suppresses them along
 * with explicitly verbose events. They remain durable in the session log. Errors, failed tools,
 * diagnostics, and warning UI outside the notice stream are unaffected. */
export function isEventVisible(
  event: { type: string; payload: unknown },
  verbose = false,
): boolean {
  const payload = event.payload as { visibility?: unknown; level?: unknown } | null;
  return (
    verbose ||
    (payload?.visibility !== "verbose" && !(event.type === "notice" && payload?.level === "warn"))
  );
}

/** Who produced an event: the main agent (default), the orchestrator, or a worker sub-agent. */
export interface Actor {
  role: "agent" | "orchestrator" | "worker";
  taskId?: string;
}

/** Minimal write seam used by the runtime/orchestrator. EventLog implements it. */
export interface EventSink {
  append(input: EventInput): Event;
}

/** Read an event's actor, defaulting to the main agent when untagged. */
export function actorOf(event: Pick<Event, "payload">): Actor {
  const a = (event.payload as { actor?: Actor } | null)?.actor;
  return a ?? { role: "agent" };
}
