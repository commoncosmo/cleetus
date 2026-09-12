import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CheckpointMetaStore } from "../../src/checkpoint/meta-store";
import type { TodoItem } from "../../src/tools/types";

function store(max = 20): CheckpointMetaStore {
  return new CheckpointMetaStore(new Database(":memory:"), max);
}

describe("CheckpointMetaStore", () => {
  test("nextTurnNumber starts at 0 and increments off the max", () => {
    const m = store();
    expect(m.nextTurnNumber("s1")).toBe(0);
    m.add({
      sessionId: "s1",
      turnNumber: 0,
      commitSha: "a",
      historyLength: 0,
      userInput: "t0",
      ts: 1,
    });
    expect(m.nextTurnNumber("s1")).toBe(1);
    // Other sessions are independent.
    expect(m.nextTurnNumber("s2")).toBe(0);
  });

  test("list returns the session's rows oldest-first as summaries", () => {
    const m = store();
    m.add({
      sessionId: "s1",
      turnNumber: 0,
      commitSha: "a",
      historyLength: 0,
      userInput: "first",
      ts: 10,
    });
    m.add({
      sessionId: "s1",
      turnNumber: 1,
      commitSha: "b",
      historyLength: 2,
      userInput: "second",
      ts: 20,
    });
    m.add({
      sessionId: "s2",
      turnNumber: 0,
      commitSha: "c",
      historyLength: 0,
      userInput: "other",
      ts: 30,
    });
    expect(m.list("s1")).toEqual([
      { turnNumber: 0, userInput: "first", ts: 10 },
      { turnNumber: 1, userInput: "second", ts: 20 },
    ]);
  });

  test("get round-trips all fields including todos and a null commit", () => {
    const m = store();
    const todos: TodoItem[] = [{ content: "x", status: "pending" }];
    m.add({
      sessionId: "s1",
      turnNumber: 0,
      commitSha: null,
      historyLength: 5,
      userInput: "t",
      todos,
      ts: 99,
    });
    expect(m.get("s1", 0)).toEqual({
      sessionId: "s1",
      turnNumber: 0,
      commitSha: null,
      historyLength: 5,
      userInput: "t",
      todos,
      ts: 99,
    });
    expect(m.get("s1", 7)).toBeUndefined();
  });

  test("countFrom counts the target and later turns", () => {
    const m = store();
    for (let n = 0; n < 4; n++) {
      m.add({
        sessionId: "s1",
        turnNumber: n,
        commitSha: "x",
        historyLength: n,
        userInput: `t${n}`,
        ts: n,
      });
    }
    expect(m.countFrom("s1", 1)).toBe(3);
    expect(m.countFrom("s1", 0)).toBe(4);
    expect(m.countFrom("s1", 9)).toBe(0);
  });

  test("truncateFrom deletes the target and later turns only for that session", () => {
    const m = store();
    for (let n = 0; n < 3; n++) {
      m.add({
        sessionId: "s1",
        turnNumber: n,
        commitSha: "x",
        historyLength: n,
        userInput: `t${n}`,
        ts: n,
      });
    }
    m.add({
      sessionId: "s2",
      turnNumber: 0,
      commitSha: "y",
      historyLength: 0,
      userInput: "keep",
      ts: 0,
    });
    m.truncateFrom("s1", 1);
    expect(m.list("s1").map((c) => c.turnNumber)).toEqual([0]);
    expect(m.list("s2").map((c) => c.turnNumber)).toEqual([0]);
  });

  test("the cap keeps only the newest N rows per session", () => {
    const m = store(2);
    for (let n = 0; n < 4; n++) {
      m.add({
        sessionId: "s1",
        turnNumber: n,
        commitSha: "x",
        historyLength: n,
        userInput: `t${n}`,
        ts: n,
      });
    }
    expect(m.list("s1").map((c) => c.turnNumber)).toEqual([2, 3]);
  });
});
