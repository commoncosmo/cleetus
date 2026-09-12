import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoListDeleteTool, TodoListShowTool, TodoListWriteTool } from "../../src/tools/todo-list";
import { TodoListStore } from "../../src/tools/todo-list-store";

let gdir: string;
let pdir: string;
const ctx = () => ({ projectDir: "/tmp", abortSignal: new AbortController().signal });
let stores: { global: TodoListStore; project: TodoListStore };

beforeEach(async () => {
  gdir = await mkdtemp(join(tmpdir(), "cleetus-tl-global-"));
  pdir = await mkdtemp(join(tmpdir(), "cleetus-tl-project-"));
  stores = { global: new TodoListStore(gdir), project: new TodoListStore(pdir) };
});
afterEach(async () => {
  await rm(gdir, { recursive: true, force: true });
  await rm(pdir, { recursive: true, force: true });
});

describe("TodoListWriteTool", () => {
  it("creates a list (default project scope) and renders it", async () => {
    const tool = new TodoListWriteTool(stores);
    const r = await tool.run(
      { name: "groceries", todos: [{ content: "milk", status: "pending" }] },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("groceries (project) — 0/1 done:\n[ ] milk");
    expect(r.todos).toEqual([{ content: "milk", status: "pending" }]);
    expect(r.todosTitle).toBe("groceries (project)");
    expect(stores.project.read("groceries")).toEqual([{ content: "milk", status: "pending" }]);
  });
  it("writes to the global scope when asked", async () => {
    const tool = new TodoListWriteTool(stores);
    await tool.run(
      { name: "stuff", scope: "global", todos: [{ content: "x", status: "pending" }] },
      ctx(),
    );
    expect(stores.global.read("stuff")).toEqual([{ content: "x", status: "pending" }]);
    expect(stores.project.read("stuff")).toEqual([]);
  });
  it("allows multiple in_progress items (relaxed rule)", async () => {
    const tool = new TodoListWriteTool(stores);
    const r = await tool.run(
      {
        name: "wip",
        todos: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "in_progress" },
        ],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
  });
  it("clears items but keeps the list on an empty array", async () => {
    const tool = new TodoListWriteTool(stores);
    await tool.run({ name: "g", todos: [{ content: "x", status: "pending" }] }, ctx());
    const r = await tool.run({ name: "g", todos: [] }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("g (project) — empty.");
    expect(stores.project.listNames()).toEqual(["g"]); // file still exists
  });
  it("rejects an invalid name", async () => {
    const tool = new TodoListWriteTool(stores);
    const r = await tool.run({ name: "../escape", todos: [] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("invalid list name");
  });
  it("rejects an empty-string name", async () => {
    const r = await new TodoListWriteTool(stores).run({ name: "", todos: [] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("invalid list name");
  });
  it("rejects malformed todos with a 1-based error", async () => {
    const tool = new TodoListWriteTool(stores);
    const r = await tool.run({ name: "g", todos: [{ content: "", status: "pending" }] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("todo 1: content must be a non-empty string");
  });
  it("serializes a summary", () => {
    expect(new TodoListWriteTool(stores).serialize({ name: "g", todos: [{}, {}] })).toBe(
      "todo_list_write g (project, 2 todos)",
    );
  });
});

describe("TodoListShowTool", () => {
  it("shows a named list with a title", async () => {
    stores.project.write("g", [{ content: "milk", status: "completed" }]);
    const r = await new TodoListShowTool(stores).run({ name: "g" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("g (project) — 1/1 done:\n[x] milk");
    expect(r.todos).toEqual([{ content: "milk", status: "completed" }]);
    expect(r.todosTitle).toBe("g (project)");
  });
  it("lists names when no name is given", async () => {
    stores.project.write("a", [{ content: "x", status: "pending" }]);
    stores.project.write("b", [{ content: "y", status: "pending" }]);
    const r = await new TodoListShowTool(stores).run({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Named lists (project): a, b");
  });
  it("reports an empty scope when there are no lists", async () => {
    const r = await new TodoListShowTool(stores).run({ scope: "global" }, ctx());
    expect(r.output).toBe("No named lists in global.");
  });
  it("serializes show", () => {
    expect(new TodoListShowTool(stores).serialize({ name: "g", scope: "global" })).toBe(
      "todo_list_show g (global)",
    );
    expect(new TodoListShowTool(stores).serialize({})).toBe("todo_list_show (list) (project)");
  });
  it("treats an empty-string name as discovery", async () => {
    stores.project.write("a", [{ content: "x", status: "pending" }]);
    const r = await new TodoListShowTool(stores).run({ name: "" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Named lists (project): a");
  });
});

describe("TodoListDeleteTool", () => {
  it("deletes an existing list", async () => {
    stores.project.write("g", [{ content: "x", status: "pending" }]);
    const r = await new TodoListDeleteTool(stores).run({ name: "g" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Deleted list g (project).");
    expect(stores.project.listNames()).toEqual([]);
  });
  it("returns ok:false when the list does not exist", async () => {
    const r = await new TodoListDeleteTool(stores).run({ name: "ghost" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("no list named ghost in project");
  });
  it("rejects an invalid name", async () => {
    const r = await new TodoListDeleteTool(stores).run({ name: "a/b" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("invalid list name");
  });
  it("serializes delete", () => {
    expect(new TodoListDeleteTool(stores).serialize({ name: "g", scope: "global" })).toBe(
      "todo_list_delete g (global)",
    );
    expect(new TodoListDeleteTool(stores).serialize({ name: "g" })).toBe(
      "todo_list_delete g (project)",
    );
  });
});
