import { parseTodoItems, renderTodoItemLines } from "./todo-core";
import { type TodoListStore, isValidListName } from "./todo-list-store";
import { renderTodoLines } from "./todo-write";
import type { TodoItem, Tool, ToolContext, ToolResult } from "./types";

type Scope = "global" | "project";
type Stores = { global: TodoListStore; project: TodoListStore };

const NAME_HINT =
  "invalid list name; use lowercase letters, digits, dash, or underscore (max 64 chars)";

function pickScope(args: unknown): Scope {
  return (args as { scope?: unknown }).scope === "global" ? "global" : "project";
}

/** "name (scope) — D/T done:" + item lines, or "name (scope) — empty." */
function renderNamedList(name: string, scope: Scope, todos: TodoItem[]): string {
  const title = `${name} (${scope})`;
  if (todos.length === 0) return `${title} — empty.`;
  const done = todos.filter((t) => t.status === "completed").length;
  return [`${title} — ${done}/${todos.length} done:`, ...renderTodoItemLines(todos)].join("\n");
}

export class TodoListShowTool implements Tool {
  name = "todo_list_show";
  description =
    "Show a named todo list, or list the existing named lists. Pass `name` to display that " +
    "list's items; omit `name` to list the names of all lists in the scope. `scope` is " +
    "`project` (default) or `global`. These are durable, user-curated lists — use them only " +
    "when the user asks, not as your working plan.";
  parameters = {
    type: "object",
    properties: {
      name: { type: "string" },
      scope: { type: "string", enum: ["global", "project"], description: "default project" },
    },
  };

  constructor(private readonly stores: Stores) {}

  serialize(args: unknown): string {
    const a = args as { name?: string; scope?: string };
    const scope = a.scope === "global" ? "global" : "project";
    return `todo_list_show ${a.name ?? "(list)"} (${scope})`;
  }

  async run(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const name = (args as { name?: unknown }).name;
    const scope = pickScope(args);
    const store = this.stores[scope];
    if (name === undefined || name === null || name === "") {
      const names = store.listNames();
      const output =
        names.length === 0
          ? `No named lists in ${scope}.`
          : `Named lists (${scope}): ${names.join(", ")}`;
      return { ok: true, output };
    }
    if (!isValidListName(name)) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: NAME_HINT };
    }
    const todos = store.read(name);
    return {
      ok: true,
      output: renderNamedList(name, scope, todos),
      todos,
      todosTitle: `${name} (${scope})`,
    };
  }
}

export class TodoListWriteTool implements Tool {
  name = "todo_list_write";
  description =
    "Create or replace a named todo list (durable, user-curated). Send the FULL `todos` array " +
    "(it replaces the list; an empty array clears it but keeps the list). Each item has " +
    "`content` and a `status` of pending, in_progress, or completed. `scope` is `project` " +
    "(default) or `global`. Show the list first if you need its current contents. " +
    "This does not update the working checklist or progress counter; use todo_write for those.";
  parameters = {
    type: "object",
    properties: {
      name: { type: "string" },
      scope: { type: "string", enum: ["global", "project"], description: "default project" },
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
    required: ["name", "todos"],
  };

  constructor(private readonly stores: Stores) {}

  serialize(args: unknown): string {
    const a = args as { name?: string; scope?: string; todos?: unknown };
    const scope = a.scope === "global" ? "global" : "project";
    const n = Array.isArray(a.todos) ? a.todos.length : 0;
    return `todo_list_write ${a.name ?? "?"} (${scope}, ${n} todos)`;
  }

  async run(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const name = (args as { name?: unknown }).name;
    const scope = pickScope(args);
    if (!isValidListName(name)) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: NAME_HINT };
    }
    const parsed = parseTodoItems((args as { todos?: unknown }).todos);
    if (!parsed.ok) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: parsed.error };
    }
    this.stores[scope].write(name, parsed.todos);
    return {
      ok: true,
      output: renderNamedList(name, scope, parsed.todos),
      todos: parsed.todos,
      todosTitle: `${name} (${scope})`,
    };
  }
}

export class TodoListDeleteTool implements Tool {
  name = "todo_list_delete";
  description =
    "Delete a named todo list entirely (removes the file). `scope` is `project` (default) or " +
    "`global`. This is permanent.";
  parameters = {
    type: "object",
    properties: {
      name: { type: "string" },
      scope: { type: "string", enum: ["global", "project"], description: "default project" },
    },
    required: ["name"],
  };

  constructor(private readonly stores: Stores) {}

  serialize(args: unknown): string {
    const a = args as { name?: string; scope?: string };
    const scope = a.scope === "global" ? "global" : "project";
    return `todo_list_delete ${a.name ?? "?"} (${scope})`;
  }

  async run(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const name = (args as { name?: unknown }).name;
    const scope = pickScope(args);
    if (!isValidListName(name)) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: NAME_HINT };
    }
    const deleted = this.stores[scope].delete(name);
    if (!deleted) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: `no list named ${name} in ${scope}`,
      };
    }
    return { ok: true, output: `Deleted list ${name} (${scope}).` };
  }
}

export class TodoListSaveTool implements Tool {
  name = "todo_list_save";
  description =
    "Save your current working todo list under a name (durable, user-curated). Writes the " +
    "session's active list to the named list, replacing it if it exists. `scope` is `project` " +
    "(default) or `global`. Use when the user asks to save or stash the current list.";
  parameters = {
    type: "object",
    properties: {
      name: { type: "string" },
      scope: { type: "string", enum: ["global", "project"], description: "default project" },
    },
    required: ["name"],
  };

  constructor(private readonly stores: Stores) {}

  serialize(args: unknown): string {
    const a = args as { name?: string; scope?: string };
    const scope = a.scope === "global" ? "global" : "project";
    return `todo_list_save ${a.name ?? "?"} (${scope})`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const name = (args as { name?: unknown }).name;
    const scope = pickScope(args);
    if (!isValidListName(name)) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: NAME_HINT };
    }
    const todos = ctx.sessionTodos;
    // An empty working list (e.g. after todo_write []) is not saveable — treat it like absent.
    if (todos === undefined || todos.length === 0) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: "no active todo list to save" };
    }
    this.stores[scope].write(name, todos);
    return {
      ok: true,
      output: `Saved working list as ${name} (${scope}).`,
      todos,
      // Titled so the runtime does NOT re-adopt this save as the session working list.
      todosTitle: `${name} (${scope})`,
    };
  }
}

export class TodoListLoadTool implements Tool {
  name = "todo_list_load";
  description =
    "Load a named todo list as your working list so you can act on it. Replaces the current " +
    "working list with the named list's items. `scope` is `project` (default) or `global`.";
  parameters = {
    type: "object",
    properties: {
      name: { type: "string" },
      scope: { type: "string", enum: ["global", "project"], description: "default project" },
    },
    required: ["name"],
  };

  constructor(private readonly stores: Stores) {}

  serialize(args: unknown): string {
    const a = args as { name?: string; scope?: string };
    const scope = a.scope === "global" ? "global" : "project";
    return `todo_list_load ${a.name ?? "?"} (${scope})`;
  }

  async run(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const name = (args as { name?: unknown }).name;
    const scope = pickScope(args);
    if (!isValidListName(name)) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: NAME_HINT };
    }
    const store = this.stores[scope];
    if (!store.listNames().includes(name)) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: `no list named ${name} in ${scope}`,
      };
    }
    const todos = store.read(name);
    if (todos.length === 0) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: `${name} (${scope}) is empty; nothing to load`,
      };
    }
    return {
      ok: true,
      output: `Loaded ${name} (${scope}) as the working list:\n${renderTodoLines(todos)}`,
      // Deliberately no todosTitle: the runtime treats a todos result without a title as
      // the new session working list. Adding a title here would suppress that tracking.
      todos,
    };
  }
}
