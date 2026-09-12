import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoListLoadTool, TodoListSaveTool } from "../../src/tools/todo-list";
import { TodoListStore } from "../../src/tools/todo-list-store";
import type { TodoItem } from "../../src/tools/types";

let gdir: string;
let pdir: string;
let stores: { global: TodoListStore; project: TodoListStore };

const ctx = (sessionTodos?: TodoItem[]) => ({
  projectDir: "/tmp",
  abortSignal: new AbortController().signal,
  sessionTodos,
});

const T: TodoItem[] = [
  { content: "a", status: "completed" },
  { content: "b", status: "pending" },
];

beforeEach(async () => {
  gdir = await mkdtemp(join(tmpdir(), "cleetus-tlb-global-"));
  pdir = await mkdtemp(join(tmpdir(), "cleetus-tlb-project-"));
  stores = { global: new TodoListStore(gdir), project: new TodoListStore(pdir) };
});
afterEach(async () => {
  await rm(gdir, { recursive: true, force: true });
  await rm(pdir, { recursive: true, force: true });
});

describe("TodoListSaveTool", () => {
  it("saves the session working list under a name (default project)", async () => {
    const tool = new TodoListSaveTool(stores);
    const r = await tool.run({ name: "snap" }, ctx(T));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Saved working list as snap (project).");
    expect(r.todos).toEqual(T);
    expect(r.todosTitle).toBe("snap (project)");
    expect(stores.project.read("snap")).toEqual(T);
  });

  it("saves to the global scope when asked", async () => {
    const tool = new TodoListSaveTool(stores);
    await tool.run({ name: "snap", scope: "global" }, ctx(T));
    expect(stores.global.read("snap")).toEqual(T);
  });

  it("errors when there is no active working list", async () => {
    const tool = new TodoListSaveTool(stores);
    const r = await tool.run({ name: "snap" }, ctx(undefined));
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("no active todo list to save");
  });

  it("errors when the working list is empty", async () => {
    const tool = new TodoListSaveTool(stores);
    const r = await tool.run({ name: "snap" }, ctx([]));
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("no active todo list to save");
  });

  it("rejects an invalid name", async () => {
    const tool = new TodoListSaveTool(stores);
    const r = await tool.run({ name: "../escape" }, ctx(T));
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("invalid list name");
  });

  it("serializes with name and scope", () => {
    const tool = new TodoListSaveTool(stores);
    expect(tool.serialize({ name: "snap", scope: "global" })).toBe("todo_list_save snap (global)");
  });
});

describe("TodoListLoadTool", () => {
  it("loads a named list as the working list (no title, session-style output)", async () => {
    stores.project.write("groceries", T);
    const tool = new TodoListLoadTool(stores);
    const r = await tool.run({ name: "groceries" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.todos).toEqual(T);
    expect(r.todosTitle).toBeUndefined();
    expect(r.output).toContain("Loaded groceries (project) as the working list:");
    expect(r.output).toContain("[ ] b");
  });

  it("loads from the global scope when asked", async () => {
    stores.global.write("g", T);
    const tool = new TodoListLoadTool(stores);
    const r = await tool.run({ name: "g", scope: "global" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.todos).toEqual(T);
    expect(r.todosTitle).toBeUndefined();
  });

  it("errors when the named list does not exist", async () => {
    const tool = new TodoListLoadTool(stores);
    const r = await tool.run({ name: "missing" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("no list named missing in project");
  });

  it("errors when the named list exists but is empty", async () => {
    stores.project.write("empty", []);
    const tool = new TodoListLoadTool(stores);
    const r = await tool.run({ name: "empty" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("empty (project) is empty; nothing to load");
  });

  it("rejects an invalid name", async () => {
    const tool = new TodoListLoadTool(stores);
    const r = await tool.run({ name: "a/b" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("invalid list name");
  });

  it("serializes with name and scope", () => {
    const tool = new TodoListLoadTool(stores);
    expect(tool.serialize({ name: "g", scope: "global" })).toBe("todo_list_load g (global)");
  });
});
