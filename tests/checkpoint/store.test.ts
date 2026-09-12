import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "../../src/checkpoint/store";
import type { TodoItem } from "../../src/tools/types";

const SID = "s1";

describe("CheckpointStore", () => {
  test("begin assigns monotonic turn numbers", () => {
    const s = new CheckpointStore(20);
    s.begin(SID, "first", 0);
    s.begin(SID, "second", 2);
    expect(s.list(SID).map((c) => c.turnNumber)).toEqual([0, 1]);
  });

  test("keeps independent rings and turn numbers per session", () => {
    const s = new CheckpointStore(20);
    s.begin("one", "one-a", 0);
    s.begin("two", "two-a", 0);
    s.begin("one", "one-b", 2);

    expect(s.list("one").map((c) => [c.turnNumber, c.userInput])).toEqual([
      [0, "one-a"],
      [1, "one-b"],
    ]);
    expect(s.list("two").map((c) => [c.turnNumber, c.userInput])).toEqual([[0, "two-a"]]);
  });

  test("recordFile keeps the first touch per path", () => {
    const s = new CheckpointStore(20);
    s.begin(SID, "t", 0);
    s.recordFile("/a.ts", "original", false);
    s.recordFile("/a.ts", "mutated-again", false);
    expect(s.list(SID)[0]!.files.get("/a.ts")!.before).toBe("original");
  });

  test("recordFile before any begin is a no-op", () => {
    const s = new CheckpointStore(20);
    s.recordFile("/a.ts", "x", false);
    expect(s.list(SID)).toEqual([]);
  });

  test("ring evicts the oldest past the cap", () => {
    const s = new CheckpointStore(2);
    s.begin(SID, "a", 0);
    s.begin(SID, "b", 0);
    s.begin(SID, "c", 0);
    expect(s.list(SID).map((c) => c.turnNumber)).toEqual([1, 2]);
  });

  test("rewindTo an evicted turn returns null", async () => {
    const s = new CheckpointStore(2);
    s.begin(SID, "a", 0);
    s.begin(SID, "b", 0);
    s.begin(SID, "c", 0);
    expect(await s.rewindTo(SID, 0)).toBeNull();
  });

  test("a degenerate cap of 0 is clamped so a checkpoint survives", () => {
    const s = new CheckpointStore(0);
    s.begin(SID, "a", 0);
    s.recordFile("/a.ts", "x", false);
    expect(s.list(SID).length).toBe(1);
    expect(s.list(SID)[0]!.files.get("/a.ts")!.before).toBe("x");
  });

  test("rewindTo restores edited files and deletes created files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cp-"));
    const edited = join(dir, "edited.ts");
    const fresh = join(dir, "fresh.ts");
    await writeFile(edited, "ORIGINAL");

    const s = new CheckpointStore(20);
    s.begin(SID, "turn 0", 4);
    s.recordFile(edited, "ORIGINAL", false);
    s.recordFile(fresh, "", true);
    await writeFile(edited, "CHANGED");
    await writeFile(fresh, "BRAND NEW");

    const outcome = await s.rewindTo(SID, 0);
    expect(outcome).not.toBeNull();
    expect(outcome!.revertedTurns).toBe(1);
    expect(outcome!.filesRestored).toBe(1);
    expect(outcome!.filesDeleted).toBe(1);
    expect(outcome!.historyLength).toBe(4);
    expect(await readFile(edited, "utf8")).toBe("ORIGINAL");
    expect(existsSync(fresh)).toBe(false);
    expect(s.list(SID)).toEqual([]);
  });

  test("rewindTo an unknown turn returns null", async () => {
    const s = new CheckpointStore(20);
    s.begin(SID, "t", 0);
    expect(await s.rewindTo(SID, 99)).toBeNull();
  });

  test("rewindTo drops the target and all later checkpoints", async () => {
    const s = new CheckpointStore(20);
    s.begin(SID, "t0", 0);
    s.begin(SID, "t1", 2);
    s.begin(SID, "t2", 4);
    const outcome = await s.rewindTo(SID, 1);
    expect(outcome!.revertedTurns).toBe(2);
    expect(s.list(SID).map((c) => c.turnNumber)).toEqual([0]);
  });

  test("begin records the working-list snapshot", () => {
    const s = new CheckpointStore(20);
    const todos: TodoItem[] = [
      { content: "one", status: "completed" },
      { content: "two", status: "pending" },
    ];
    s.begin(SID, "t", 0, todos);
    expect(s.list(SID)[0]!.todos).toEqual(todos);
  });

  test("begin with no todos leaves the snapshot undefined", () => {
    const s = new CheckpointStore(20);
    s.begin(SID, "t", 0);
    expect(s.list(SID)[0]!.todos).toBeUndefined();
  });

  test("rewindTo returns the earliest undone turn's todos across a multi-turn revert", async () => {
    const before: TodoItem[] = [{ content: "before-turn-0", status: "pending" }];
    const s = new CheckpointStore(20);
    s.begin(SID, "turn 0", 0, before);
    s.begin(SID, "turn 1", 1, [{ content: "before-turn-1", status: "pending" }]);
    const outcome = await s.rewindTo(SID, 0);
    expect(outcome!.todos).toEqual(before);
  });

  test("rewindTo a turn that created the first todos returns undefined", async () => {
    const s = new CheckpointStore(20);
    s.begin(SID, "create todos", 0);
    const outcome = await s.rewindTo(SID, 0);
    expect(outcome!.todos).toBeUndefined();
  });
});
