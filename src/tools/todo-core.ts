import type { TodoItem, TodoStatus } from "./types";

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

/** completed → "[x]", in_progress → "[→]", pending → "[ ]". */
export function todoGlyph(status: TodoStatus): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[→]";
  return "[ ]";
}

/** One `<glyph> <content>` line per item (no header). */
export function renderTodoItemLines(todos: TodoItem[]): string[] {
  return todos.map((t) => `${todoGlyph(t.status)} ${t.content}`);
}

export type ParseTodosResult = { ok: true; todos: TodoItem[] } | { ok: false; error: string };

/**
 * Validate a replace-whole-list `todos` payload atomically with 1-based error
 * indices. Non-array → error; empty array → ok (cleared); each item needs a
 * non-empty (trimmed) `content` and an enum `status`. Does NOT enforce the
 * at-most-one-`in_progress` rule — that is the session tool's focus nudge, applied
 * by `todo_write` on top of this.
 */
export function parseTodoItems(raw: unknown): ParseTodosResult {
  if (!Array.isArray(raw)) return { ok: false, error: "no todos provided" };
  const todos: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = (raw[i] ?? {}) as Record<string, unknown>;
    const content = item.content;
    const status = item.status;
    if (typeof content !== "string" || content.trim().length === 0) {
      return { ok: false, error: `todo ${i + 1}: content must be a non-empty string` };
    }
    if (typeof status !== "string" || !STATUSES.includes(status as TodoStatus)) {
      return {
        ok: false,
        error: `todo ${i + 1}: status must be one of pending, in_progress, completed`,
      };
    }
    todos.push({ content, status: status as TodoStatus });
  }
  return { ok: true, todos };
}
