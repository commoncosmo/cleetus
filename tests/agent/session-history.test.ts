import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SessionHistoryStore } from "../../src/agent/session-history";
import type { Message } from "../../src/providers/types";
import type { TodoItem } from "../../src/tools/types";

function store(): SessionHistoryStore {
  return new SessionHistoryStore(new Database(":memory:"));
}

const MSGS: Message[] = [
  { role: "user", content: "hi" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c1", name: "bash", args: { command: "ls" } }],
  },
  { role: "tool", toolCallId: "c1", content: "file.txt" },
  { role: "assistant", content: "done" },
];
const TODOS: TodoItem[] = [{ content: "ship it", status: "pending" }];

describe("SessionHistoryStore", () => {
  test("save then load round-trips messages (incl. toolCalls) and todos", () => {
    const s = store();
    s.save("sess1", MSGS, TODOS);
    expect(s.load("sess1")).toEqual({ messages: MSGS, todos: TODOS });
  });

  test("save upserts — second save replaces the first", () => {
    const s = store();
    s.save("sess1", MSGS, TODOS);
    const next: Message[] = [{ role: "user", content: "again" }];
    s.save("sess1", next, []);
    expect(s.load("sess1")).toEqual({ messages: next, todos: [] });
  });

  test("load of an absent session is undefined", () => {
    expect(store().load("nope")).toBeUndefined();
  });

  test("copy duplicates a snapshot under a new id, independently", () => {
    const s = store();
    s.save("src", MSGS, TODOS);
    s.copy("src", "dst");
    expect(s.load("dst")).toEqual({ messages: MSGS, todos: TODOS });
    s.save("src", [{ role: "user", content: "changed" }], []);
    expect(s.load("dst")).toEqual({ messages: MSGS, todos: TODOS });
  });

  test("copy from an id with no snapshot is a no-op", () => {
    const s = store();
    s.copy("ghost", "dst");
    expect(s.load("dst")).toBeUndefined();
  });

  test("copy overwrites an existing destination snapshot", () => {
    const s = store();
    s.save("src", MSGS, TODOS);
    s.save("dst", [{ role: "user", content: "old dst" }], []);
    s.copy("src", "dst");
    expect(s.load("dst")).toEqual({ messages: MSGS, todos: TODOS });
  });

  test("exists reflects presence without deserializing", () => {
    const s = store();
    expect(s.exists("x")).toBe(false);
    s.save("x", MSGS, TODOS);
    expect(s.exists("x")).toBe(true);
  });
});
