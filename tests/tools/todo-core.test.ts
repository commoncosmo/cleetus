import { describe, expect, it } from "bun:test";
import { parseTodoItems, renderTodoItemLines, todoGlyph } from "../../src/tools/todo-core";

describe("todoGlyph", () => {
  it("maps each status to a glyph", () => {
    expect(todoGlyph("completed")).toBe("[x]");
    expect(todoGlyph("in_progress")).toBe("[→]");
    expect(todoGlyph("pending")).toBe("[ ]");
  });
});

describe("renderTodoItemLines", () => {
  it("renders one glyph+content line per item, no header", () => {
    expect(
      renderTodoItemLines([
        { content: "a", status: "completed" },
        { content: "b", status: "pending" },
      ]),
    ).toEqual(["[x] a", "[ ] b"]);
  });
});

describe("parseTodoItems", () => {
  it("rejects a non-array", () => {
    expect(parseTodoItems("nope")).toEqual({ ok: false, error: "no todos provided" });
  });
  it("accepts an empty array (cleared)", () => {
    expect(parseTodoItems([])).toEqual({ ok: true, todos: [] });
  });
  it("validates content and status with 1-based errors", () => {
    expect(
      parseTodoItems([
        { content: "a", status: "completed" },
        { content: "b", status: "x" },
      ]),
    ).toEqual({
      ok: false,
      error: "todo 2: status must be one of pending, in_progress, completed",
    });
    expect(parseTodoItems([{ content: "  ", status: "pending" }])).toEqual({
      ok: false,
      error: "todo 1: content must be a non-empty string",
    });
  });
  it("does NOT enforce the one-in_progress rule (relaxed for shared use)", () => {
    const r = parseTodoItems([
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
    ]);
    expect(r.ok).toBe(true);
  });
});
