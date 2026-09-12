import { type ParseTodosResult, parseTodoItems, renderTodoItemLines, todoGlyph } from "./todo-core";
import type { TodoItem, Tool, ToolContext, ToolResult } from "./types";

// Re-exported so existing importers/tests keep resolving these from todo-write.
export { todoGlyph };

/** "Todos (D/T done):" followed by one `<glyph> <content>` line per item. */
export function renderTodoLines(todos: TodoItem[]): string {
  if (todos.length === 0) return "Todo list cleared.";
  const done = todos.filter((t) => t.status === "completed").length;
  return [`Todos (${done}/${todos.length} done):`, ...renderTodoItemLines(todos)].join("\n");
}

/** Session-list validation: shared per-item checks plus the one-in_progress focus rule. */
function validate(args: unknown): ParseTodosResult {
  const parsed = parseTodoItems((args as { todos?: unknown }).todos);
  if (!parsed.ok) return parsed;
  if (parsed.todos.filter((t) => t.status === "in_progress").length > 1) {
    return { ok: false, error: "only one todo may be in_progress at a time" };
  }
  return parsed;
}

export class TodoWriteTool implements Tool {
  name = "todo_write";
  description =
    "Record or update your task list for a multi-step job. Send the FULL list every time " +
    "(it replaces the previous one); each item has `content` and a `status` of pending, " +
    "in_progress, or completed. Keep one item in_progress while you work on it. Use this to " +
    "plan and track progress so you stay on task.";
  parameters = {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  };

  serialize(args: unknown): string {
    const todos = (args as { todos?: unknown }).todos;
    const arr = Array.isArray(todos) ? (todos as { status?: unknown }[]) : [];
    if (arr.length === 0) return "todo_write (cleared)";
    const done = arr.filter((t) => t.status === "completed").length;
    return `todo_write (${arr.length} todos, ${done}/${arr.length} done)`;
  }

  async run(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const v = validate(args);
    if (!v.ok) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: v.error };
    }
    return { ok: true, output: renderTodoLines(v.todos), todos: v.todos };
  }
}
