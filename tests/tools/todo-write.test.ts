import { describe, expect, it } from "bun:test";
import { TodoWriteTool, renderTodoLines, todoGlyph } from "../../src/tools/todo-write";

const ctx = () => ({ projectDir: "/tmp", abortSignal: new AbortController().signal });
const tool = new TodoWriteTool();

describe("todoGlyph", () => {
  it("maps each status to a glyph", () => {
    expect(todoGlyph("completed")).toBe("[x]");
    expect(todoGlyph("in_progress")).toBe("[→]");
    expect(todoGlyph("pending")).toBe("[ ]");
  });
});

describe("renderTodoLines", () => {
  it("renders a header with done/total and one line per item", () => {
    expect(
      renderTodoLines([
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ]),
    ).toBe("Todos (1/3 done):\n[x] a\n[→] b\n[ ] c");
  });

  it("renders a cleared message for an empty list", () => {
    expect(renderTodoLines([])).toBe("Todo list cleared.");
  });
});

describe("TodoWriteTool", () => {
  it("accepts a valid list and echoes the rendered checklist + todos", async () => {
    const todos = [
      { content: "write the failing test", status: "completed" as const },
      { content: "implement", status: "in_progress" as const },
      { content: "refactor", status: "pending" as const },
    ];
    const r = await tool.run({ todos }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe(
      "Todos (1/3 done):\n[x] write the failing test\n[→] implement\n[ ] refactor",
    );
    expect(r.todos).toEqual(todos);
  });

  it("clears the list when given an empty todos array", async () => {
    const r = await tool.run({ todos: [] }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Todo list cleared.");
    expect(r.todos).toEqual([]);
  });

  it("rejects a non-array todos", async () => {
    const r = await tool.run({ todos: "nope" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("no todos provided");
  });

  it("rejects an invalid status with a 1-based index", async () => {
    const r = await tool.run(
      {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "doing" },
        ],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("todo 2: status must be one of pending, in_progress, completed");
  });

  it("rejects empty content with a 1-based index", async () => {
    const r = await tool.run({ todos: [{ content: "", status: "pending" }] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("todo 1: content must be a non-empty string");
  });

  it("rejects whitespace-only content", async () => {
    const r = await tool.run({ todos: [{ content: "   ", status: "pending" }] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("todo 1: content must be a non-empty string");
  });

  it("rejects a null element inside the array", async () => {
    const r = await tool.run({ todos: [null] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("todo 1: content must be a non-empty string");
  });

  it("rejects a primitive element inside the array", async () => {
    const r = await tool.run({ todos: [42] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("todo 1: content must be a non-empty string");
  });

  it("rejects more than one in_progress item", async () => {
    const r = await tool.run(
      {
        todos: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "in_progress" },
        ],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("only one todo may be in_progress at a time");
  });

  it("allows zero in_progress items", async () => {
    const r = await tool.run(
      {
        todos: [
          { content: "a", status: "pending" },
          { content: "b", status: "completed" },
        ],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
  });

  it("serializes a one-line progress summary", () => {
    expect(
      tool.serialize({
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "pending" },
          { content: "c", status: "pending" },
        ],
      }),
    ).toBe("todo_write (3 todos, 1/3 done)");
  });

  it("serializes a cleared list", () => {
    expect(tool.serialize({ todos: [] })).toBe("todo_write (cleared)");
  });
});
