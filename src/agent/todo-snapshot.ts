import type { EventSource } from "../events/log";
import type { TodoItem } from "../tools/types";

export interface TodoSnapshot {
  /** The session the list came from (and where the dismiss/restore marker is written). */
  sessionId: string;
  todos: TodoItem[];
  /** `ts` of the originating todo_write tool_call_end event. */
  updatedAt: number;
}

/** Read a `todo_write` tool_call_end payload tolerantly. Returns the todos array
 * (possibly empty) or null when the payload is not a usable todo_write. A single
 * malformed item rejects the whole payload (returns null) — a corrupted list is
 * never partially restored; the event is then skipped by the caller. */
function readTodoWrite(payload: unknown): TodoItem[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { call?: unknown; todos?: unknown };
  const call = p.call as { name?: unknown } | undefined;
  if (!call || call.name !== "todo_write") return null;
  if (!Array.isArray(p.todos)) return null;
  const todos: TodoItem[] = [];
  for (const raw of p.todos) {
    if (typeof raw !== "object" || raw === null) return null;
    const item = raw as { content?: unknown; status?: unknown };
    if (typeof item.content !== "string") return null;
    if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") {
      return null;
    }
    todos.push({ content: item.content, status: item.status });
  }
  return todos;
}

/**
 * The most recent prior session's unfinished todo list, or null. Considers ONLY the
 * single most-recently-created session that is not `excludeSessionId`; does not scan
 * further back. Returns null when that session has no usable todo_write, when its last
 * list was cleared or all-completed, or when a `todo_restore` marker already followed it.
 */
export function latestUnfinishedTodos(
  source: EventSource,
  opts: { excludeSessionId: string },
): TodoSnapshot | null {
  const sessions = source.listSessions().filter((id) => id !== opts.excludeSessionId);
  if (sessions.length === 0) return null;
  const candidate = sessions[sessions.length - 1]!; // listSessions is creation-ordered
  const events = source.query(candidate);

  let lastIdx = -1;
  let lastTodos: TodoItem[] | null = null;
  let lastTs = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type !== "tool_call_end") continue;
    const todos = readTodoWrite(e.payload);
    if (todos === null) continue;
    lastIdx = i;
    lastTodos = todos;
    lastTs = e.ts;
  }
  if (lastIdx === -1 || lastTodos === null) return null;

  // Already handled: any todo_restore marker after the last todo_write.
  for (let i = lastIdx + 1; i < events.length; i++) {
    if (events[i]!.type === "todo_restore") return null;
  }

  // Two null paths converge here: no usable todo_write at all (above), vs. a usable
  // but cleared/all-completed list (below) — both mean "nothing to offer".
  if (lastTodos.length === 0) return null;
  if (!lastTodos.some((t) => t.status !== "completed")) return null;

  return { sessionId: candidate, todos: lastTodos, updatedAt: lastTs };
}
