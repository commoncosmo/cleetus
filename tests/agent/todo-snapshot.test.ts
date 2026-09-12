import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { latestUnfinishedTodos } from "../../src/agent/todo-snapshot";
import { EventLog } from "../../src/events/log";
import type { TodoItem } from "../../src/tools/types";

let dir: string;
let log: EventLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cleetus-snapshot-"));
  log = new EventLog(join(dir, "sessions.db"));
});
afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

function appendTodoWrite(sessionId: string, todos: TodoItem[]): void {
  const call = { id: ulid(), name: "todo_write", args: { todos } };
  log.append({ sessionId, type: "tool_call_start", payload: { call } });
  log.append({
    sessionId,
    type: "tool_call_end",
    payload: { call, ok: true, output: "rendered", todos },
  });
}

const unfinished: TodoItem[] = [
  { content: "done one", status: "completed" },
  { content: "doing", status: "in_progress" },
  { content: "later", status: "pending" },
];

describe("latestUnfinishedTodos", () => {
  it("returns the most recent prior session's unfinished list", () => {
    appendTodoWrite("A", [{ content: "old", status: "completed" }]);
    appendTodoWrite("B", unfinished);
    const snap = latestUnfinishedTodos(log, { excludeSessionId: "current" });
    expect(snap).not.toBeNull();
    expect(snap?.sessionId).toBe("B");
    expect(snap?.todos).toEqual(unfinished);
    const ends = log.query("B").filter((e) => e.type === "tool_call_end");
    expect(snap?.updatedAt).toBe(ends[ends.length - 1]!.ts);
  });

  it("returns null when the last todo_write cleared the list (empty)", () => {
    appendTodoWrite("B", unfinished);
    appendTodoWrite("B", []);
    expect(latestUnfinishedTodos(log, { excludeSessionId: "current" })).toBeNull();
  });

  it("returns null when every item is completed", () => {
    appendTodoWrite("B", [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ]);
    expect(latestUnfinishedTodos(log, { excludeSessionId: "current" })).toBeNull();
  });

  it("does not scan back when the most recent session has no todo_write", () => {
    appendTodoWrite("A", unfinished);
    log.append({ sessionId: "B", type: "user_input", payload: { text: "hi" } });
    expect(latestUnfinishedTodos(log, { excludeSessionId: "current" })).toBeNull();
  });

  it("never picks the excluded (current) session", () => {
    appendTodoWrite("A", unfinished);
    appendTodoWrite("C", unfinished);
    const snap = latestUnfinishedTodos(log, { excludeSessionId: "C" });
    expect(snap?.sessionId).toBe("A");
  });

  it("suppresses a list already handled by a later todo_restore marker", () => {
    appendTodoWrite("B", unfinished);
    log.append({
      sessionId: "B",
      type: "todo_restore",
      payload: { sourceSessionId: "B", action: "dismissed" },
    });
    expect(latestUnfinishedTodos(log, { excludeSessionId: "current" })).toBeNull();
  });

  it("still offers when a todo_restore marker precedes the latest todo_write", () => {
    log.append({
      sessionId: "B",
      type: "todo_restore",
      payload: { sourceSessionId: "B", action: "dismissed" },
    });
    appendTodoWrite("B", unfinished);
    const snap = latestUnfinishedTodos(log, { excludeSessionId: "current" });
    expect(snap?.sessionId).toBe("B");
  });

  it("uses the last todo_write when there are several", () => {
    appendTodoWrite("B", [{ content: "first", status: "completed" }]);
    appendTodoWrite("B", unfinished);
    const snap = latestUnfinishedTodos(log, { excludeSessionId: "current" });
    expect(snap?.todos).toEqual(unfinished);
  });

  it("returns null on an empty store", () => {
    expect(latestUnfinishedTodos(log, { excludeSessionId: "current" })).toBeNull();
  });

  it("skips malformed tool_call_end payloads without throwing", () => {
    const call = { id: ulid(), name: "edit_file", args: {} };
    log.append({ sessionId: "B", type: "tool_call_end", payload: { call, ok: true } });
    log.append({
      sessionId: "B",
      type: "tool_call_end",
      payload: { call: { id: "x", name: "todo_write", args: {} }, todos: "nope" },
    });
    expect(latestUnfinishedTodos(log, { excludeSessionId: "current" })).toBeNull();
  });

  it("returns null after the snapshot is dismissed (marker round-trip)", () => {
    appendTodoWrite("B", unfinished);
    const first = latestUnfinishedTodos(log, { excludeSessionId: "current" });
    expect(first?.sessionId).toBe("B");
    log.append({
      sessionId: first!.sessionId,
      type: "todo_restore",
      payload: { sourceSessionId: first!.sessionId, action: "dismissed" },
    });
    expect(latestUnfinishedTodos(log, { excludeSessionId: "current" })).toBeNull();
  });

  it("skips a todo_write whose item has an invalid status", () => {
    const call = { id: ulid(), name: "todo_write", args: {} };
    log.append({
      sessionId: "B",
      type: "tool_call_end",
      payload: { call, ok: true, todos: [{ content: "x", status: "bogus" }] },
    });
    expect(latestUnfinishedTodos(log, { excludeSessionId: "current" })).toBeNull();
  });
});
