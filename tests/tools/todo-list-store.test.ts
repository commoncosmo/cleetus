import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TodoListStore,
  isValidListName,
  parseList,
  serializeList,
} from "../../src/tools/todo-list-store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-todolist-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isValidListName", () => {
  it("accepts safe slugs", () => {
    expect(isValidListName("stupid-stuff")).toBe(true);
    expect(isValidListName("groceries_2")).toBe(true);
  });
  it("rejects traversal and unsafe names", () => {
    for (const bad of ["..", "a/b", ".", "-leading", "", "A-Upper", "with space", "x".repeat(65)]) {
      expect(isValidListName(bad)).toBe(false);
    }
    expect(isValidListName(42)).toBe(false);
  });
});

describe("serializeList / parseList round-trip", () => {
  it("round-trips all three statuses through the file format", () => {
    const todos = [
      { content: "pending one", status: "pending" as const },
      { content: "doing it", status: "in_progress" as const },
      { content: "did it", status: "completed" as const },
    ];
    const text = serializeList("demo", todos);
    expect(text).toBe("# demo\n- [ ] pending one\n- [~] doing it\n- [x] did it\n");
    expect(parseList(text)).toEqual(todos);
  });
  it("tolerantly ignores the title line and non-item lines", () => {
    expect(parseList("# title\n\nsome prose\n- [x] real item\n")).toEqual([
      { content: "real item", status: "completed" },
    ]);
  });
  it("normalizes newlines in content to keep each item on one line", () => {
    const text = serializeList("demo", [{ content: "line1\nline2", status: "pending" }]);
    expect(text).toBe("# demo\n- [ ] line1 line2\n");
    expect(parseList(text)).toEqual([{ content: "line1 line2", status: "pending" }]);
  });
});

describe("TodoListStore", () => {
  it("write creates the file and read round-trips", () => {
    const store = new TodoListStore(dir);
    store.write("groceries", [{ content: "milk", status: "pending" }]);
    expect(store.read("groceries")).toEqual([{ content: "milk", status: "pending" }]);
  });
  it("read of an absent list returns []", () => {
    expect(new TodoListStore(dir).read("nope")).toEqual([]);
  });
  it("listNames returns sorted basenames; empty dir → []", () => {
    const store = new TodoListStore(dir);
    expect(store.listNames()).toEqual([]);
    store.write("b", [{ content: "x", status: "pending" }]);
    store.write("a", [{ content: "y", status: "pending" }]);
    expect(store.listNames()).toEqual(["a", "b"]);
  });
  it("delete removes the file (true); deleting absent → false", () => {
    const store = new TodoListStore(dir);
    store.write("temp", [{ content: "x", status: "pending" }]);
    expect(store.delete("temp")).toBe(true);
    expect(store.read("temp")).toEqual([]);
    expect(store.delete("temp")).toBe(false);
  });
  it("throws on an unsafe name (defense in depth)", () => {
    const store = new TodoListStore(dir);
    expect(() => store.read("../escape")).toThrow();
    expect(() => store.write("a/b", [])).toThrow();
  });
  it("listNames excludes files that aren't valid list names", () => {
    const store = new TodoListStore(dir);
    store.write("good", [{ content: "x", status: "pending" }]);
    // A stray file not produced by the store (uppercase → invalid list name).
    writeFileSync(join(dir, "README.md"), "# hi\n");
    expect(store.listNames()).toEqual(["good"]);
  });
});
