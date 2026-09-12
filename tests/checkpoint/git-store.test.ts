import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCheckpointStore } from "../../src/checkpoint/git-store";
import { CheckpointMetaStore } from "../../src/checkpoint/meta-store";
import { ShadowRepo } from "../../src/checkpoint/shadow-repo";
import type { Sandbox } from "../../src/sandbox/types";
import { scriptedSandbox } from "../git/helpers";

/** A scripted sandbox where snapshot() resolves to a fixed commit sha each call. */
function snapshotSandbox(sha: string): Sandbox {
  return scriptedSandbox([
    { match: "write-tree", result: { stdout: "tree\n" } },
    { match: "rev-parse --verify --quiet", result: { exitCode: 1 } }, // force commit path
    { match: "rev-parse HEAD", result: { stdout: `${sha}\n` } },
  ]).sandbox;
}

async function build(opts: { sandbox?: Sandbox; max?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gitstore-"));
  const meta = new CheckpointMetaStore(new Database(":memory:"), opts.max ?? 20);
  const shadow = new ShadowRepo(opts.sandbox ?? snapshotSandbox("c0"), dir);
  return { store: new GitCheckpointStore({ shadow, meta }), meta, dir };
}

describe("GitCheckpointStore", () => {
  test("begin snapshots and records a metadata row with monotonic turn numbers", async () => {
    const { store } = await build();
    await store.begin("s1", "first", 0);
    await store.begin("s1", "second", 3);
    expect(store.list("s1").map((c) => c.turnNumber)).toEqual([0, 1]);
    expect(store.list("s1").map((c) => c.userInput)).toEqual(["first", "second"]);
  });

  test("recordFile is a no-op", async () => {
    const { store } = await build();
    await store.begin("s1", "t", 0);
    store.recordFile("/a.ts", "x", false);
    expect(store.list("s1").length).toBe(1);
  });

  test("a failed snapshot still records a null-commit checkpoint", async () => {
    // add -A fails → snapshot() returns null.
    const { sandbox } = scriptedSandbox([{ match: "add -A", result: { exitCode: 1 } }]);
    const { store } = await build({ sandbox });
    await store.begin("s1", "t", 2);
    const outcome = await store.rewindTo("s1", 0);
    expect(outcome).not.toBeNull();
    expect(outcome!.filesRestoreSkipped).toBe(true);
    expect(outcome!.filesRestored).toBe(0);
    expect(outcome!.historyLength).toBe(2);
  });

  test("rewindTo resolves the target sha, restores, and returns the outcome", async () => {
    // begin commits c0; restore diff reports one modified file.
    const { sandbox } = scriptedSandbox([
      { match: "rev-parse --verify --quiet", result: { exitCode: 1 } },
      { match: "write-tree", result: { stdout: "tree\n" } },
      { match: "rev-parse HEAD", result: { stdout: "c0\n" } },
      { match: "diff --name-status", result: { stdout: "M\tfile.ts\n" } },
    ]);
    const { store } = await build({ sandbox });
    await store.begin("s1", "edit", 4);
    const outcome = await store.rewindTo("s1", 0);
    expect(outcome!.revertedTurns).toBe(1);
    expect(outcome!.filesRestored).toBe(1);
    expect(outcome!.filesDeleted).toBe(0);
    expect(outcome!.userInput).toBe("edit");
    expect(outcome!.filesRestoreSkipped).toBe(false);
    expect(store.list("s1")).toEqual([]); // target + later dropped
  });

  test("rewindTo an unknown turn returns null", async () => {
    const { store } = await build();
    expect(await store.rewindTo("s1", 9)).toBeNull();
  });

  test("begin carries the working-todo snapshot through to rewind", async () => {
    const { store } = await build();
    await store.begin("s1", "t0", 0, [{ content: "before", status: "pending" }]);
    await store.begin("s1", "t1", 1);
    const outcome = await store.rewindTo("s1", 0);
    expect(outcome!.todos).toEqual([{ content: "before", status: "pending" }]);
  });
});
