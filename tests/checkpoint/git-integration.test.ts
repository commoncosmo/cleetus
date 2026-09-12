import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCheckpointStore } from "../../src/checkpoint/index";
import { NoneSandbox } from "../../src/sandbox/none";

const SID = "sess";

async function initRepo(): Promise<{ dir: string; sandbox: NoneSandbox }> {
  const dir = await mkdtemp(join(tmpdir(), "gitcp-"));
  const sandbox = new NoneSandbox(dir);
  const signal = new AbortController().signal;
  // Gitignore .cleetus/ (where the shadow repo lives) and commit it — the realistic
  // setup, and it keeps the shadow repo invisible to the user's `git status`.
  await sandbox.exec(
    "git init -q && git config user.email t@t.dev && git config user.name t && " +
      "git config commit.gpgsign false && printf '.cleetus/\\n' > .gitignore && " +
      "git add .gitignore && git commit -q -m gitignore",
    { signal },
  );
  return { dir, sandbox };
}

describe("git-backed checkpoints (integration)", () => {
  test("rewind restores edited files and deletes files created after the snapshot", async () => {
    const { dir, sandbox } = await initRepo();
    const db = new Database(":memory:");
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    await writeFile(a, "v1");

    const store = (await buildCheckpointStore(
      { enabled: true, maxCheckpoints: 20 },
      {
        sandbox,
        projectDir: dir,
        db,
      },
    ))!;

    // Turn 0: snapshot pre-turn state (a=v1, no b), then the "turn" edits a and creates b.
    await store.begin(SID, "turn 0", 0);
    await writeFile(a, "v2");
    await writeFile(b, "new");

    // Turn 1: snapshot (a=v2, b=new), then edit again.
    await store.begin(SID, "turn 1", 2);
    await writeFile(a, "v3");

    const outcome = await store.rewindTo(SID, 0);
    expect(outcome).not.toBeNull();
    expect(outcome!.revertedTurns).toBe(2);
    expect(outcome!.filesRestoreSkipped).toBe(false);
    expect(await readFile(a, "utf8")).toBe("v1");
    expect(existsSync(b)).toBe(false);
    expect(store.list(SID)).toEqual([]);
  });

  test("checkpoints survive a fresh store over the same db + shadow dir (restart)", async () => {
    const { dir, sandbox } = await initRepo();
    const db = new Database(":memory:");
    const a = join(dir, "a.txt");
    await writeFile(a, "original");

    const first = (await buildCheckpointStore(
      { enabled: true, maxCheckpoints: 20 },
      {
        sandbox,
        projectDir: dir,
        db,
      },
    ))!;
    await first.begin(SID, "turn 0", 0);
    await writeFile(a, "edited");

    // Simulate restart: a brand-new store instance over the same db + project dir.
    const resumed = (await buildCheckpointStore(
      { enabled: true, maxCheckpoints: 20 },
      {
        sandbox,
        projectDir: dir,
        db,
      },
    ))!;
    expect(resumed.list(SID).map((c) => c.turnNumber)).toEqual([0]);

    const outcome = await resumed.rewindTo(SID, 0);
    expect(outcome).not.toBeNull();
    expect(await readFile(a, "utf8")).toBe("original");
  });

  test("the user's real git history is never touched by snapshots", async () => {
    const { dir, sandbox } = await initRepo();
    const signal = new AbortController().signal;
    const tracked = join(dir, "tracked.txt");
    await writeFile(tracked, "committed");
    await sandbox.exec("git add -A && git commit -q -m initial", { signal });
    const before = (await sandbox.exec("git rev-parse HEAD && git status --porcelain", { signal }))
      .stdout;

    const store = (await buildCheckpointStore(
      { enabled: true, maxCheckpoints: 20 },
      {
        sandbox,
        projectDir: dir,
        db: new Database(":memory:"),
      },
    ))!;
    await store.begin(SID, "turn 0", 0);

    const after = (await sandbox.exec("git rev-parse HEAD && git status --porcelain", { signal }))
      .stdout;
    // The user's HEAD and porcelain status are unchanged: no stray commit, no staged
    // changes, and the shadow repo (in the gitignored .cleetus/) is invisible.
    expect(after).toBe(before);
  });
});
