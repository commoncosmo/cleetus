import { describe, expect, test } from "bun:test";
import { AgentRuntime, type AgentRuntimeOptions } from "../../src/agent/runtime";
import type { SessionHistoryStore } from "../../src/agent/session-history";
import type { Message } from "../../src/providers/types";
import type { TodoItem } from "../../src/tools/types";

function fakeStore() {
  const saved: { id: string; messages: Message[]; todos: TodoItem[] }[] = [];
  const store = {
    save(id: string, messages: Message[], todos: TodoItem[]) {
      saved.push({ id, messages, todos });
    },
  } as unknown as SessionHistoryStore;
  return { store, saved };
}

function runtimeWith(store?: SessionHistoryStore): AgentRuntime {
  return new AgentRuntime({ historyStore: store } as unknown as AgentRuntimeOptions);
}

const MSGS: Message[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
];
const TODOS: TodoItem[] = [{ content: "do it", status: "pending" }];

describe("runtime snapshot/load", () => {
  test("loadSession then snapshotSession round-trips through the store", () => {
    const { store, saved } = fakeStore();
    const rt = runtimeWith(store);
    rt.loadSession("s1", MSGS, TODOS);
    rt.snapshotSession("s1");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({ id: "s1", messages: MSGS, todos: TODOS });
  });

  test("loadSession with empty todos snapshots back empty todos", () => {
    const { store, saved } = fakeStore();
    const rt = runtimeWith(store);
    rt.loadSession("s1", MSGS, []);
    rt.snapshotSession("s1");
    expect(saved[0]).toEqual({ id: "s1", messages: MSGS, todos: [] });
  });

  test("snapshotSession is a no-op without a historyStore", () => {
    const rt = runtimeWith(undefined);
    expect(() => rt.snapshotSession("s1")).not.toThrow();
  });

  test("a throwing store does not propagate out of snapshotSession", () => {
    const store = {
      save() {
        throw new Error("disk full");
      },
    } as unknown as SessionHistoryStore;
    const rt = runtimeWith(store);
    rt.loadSession("s1", MSGS, TODOS);
    expect(() => rt.snapshotSession("s1")).not.toThrow();
  });

  test("loadSession replaces prior in-memory state for the id", () => {
    const { store, saved } = fakeStore();
    const rt = runtimeWith(store);
    rt.loadSession("s1", MSGS, TODOS);
    const replacement: Message[] = [{ role: "user", content: "fresh" }];
    rt.loadSession("s1", replacement, []);
    rt.snapshotSession("s1");
    expect(saved.at(-1)).toEqual({ id: "s1", messages: replacement, todos: [] });
  });

  test("loadSession copies todos so two sessions don't share one array", () => {
    const { store, saved } = fakeStore();
    const rt = runtimeWith(store);
    const shared: TodoItem[] = [{ content: "a", status: "pending" }];
    rt.loadSession("s1", MSGS, shared);
    rt.loadSession("s2", MSGS, shared);
    shared.push({ content: "b", status: "pending" }); // mutate the original after seeding
    rt.snapshotSession("s1");
    rt.snapshotSession("s2");
    // both snapshots reflect the 1-item list captured at load, not the mutated 2-item array
    expect(saved.find((s) => s.id === "s1")?.todos).toEqual([{ content: "a", status: "pending" }]);
    expect(saved.find((s) => s.id === "s2")?.todos).toEqual([{ content: "a", status: "pending" }]);
  });
});
