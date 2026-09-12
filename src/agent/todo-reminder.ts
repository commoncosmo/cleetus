import { renderTodoItemLines } from "../tools/todo-core";
import type { TodoItem } from "../tools/types";

/** The one-shot reminder injected into the first user turn after a compaction folded the
 *  todo_write results out of the verbatim window — the plan survives eviction independent
 *  of summarizer quality (WS6.1). "" when there is no list to restore. Pure. */
export function renderTodoReminder(todos: TodoItem[]): string {
  if (todos.length === 0) return "";
  const lines = renderTodoItemLines(todos);
  return `<system-reminder>\nCurrent working todo list (restored after history compaction):\n${lines.join("\n")}\n</system-reminder>`;
}
