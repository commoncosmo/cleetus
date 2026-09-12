import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { GitCheckpointStore } from "../../src/checkpoint/git-store";
import { buildCheckpointStore } from "../../src/checkpoint/index";
import { CheckpointStore } from "../../src/checkpoint/store";
import { recordingSandbox } from "../git/helpers";

function deps(sandbox = recordingSandbox().sandbox) {
  return { sandbox, projectDir: "/proj", db: new Database(":memory:") };
}

describe("buildCheckpointStore", () => {
  test("returns undefined when disabled", async () => {
    expect(
      await buildCheckpointStore({ enabled: false, maxCheckpoints: 20 }, deps()),
    ).toBeUndefined();
  });

  test("returns the git store in a git repo", async () => {
    // isGitRepo runs `git rev-parse --is-inside-work-tree` → "true".
    const { sandbox } = recordingSandbox({ stdout: "true\n" });
    const store = await buildCheckpointStore({ enabled: true, maxCheckpoints: 3 }, deps(sandbox));
    expect(store).toBeInstanceOf(GitCheckpointStore);
  });

  test("falls back to the in-memory store outside a git repo", async () => {
    // rev-parse exits non-zero → isGitRepo false.
    const { sandbox } = recordingSandbox({ exitCode: 1 });
    const store = await buildCheckpointStore({ enabled: true, maxCheckpoints: 3 }, deps(sandbox));
    expect(store).toBeInstanceOf(CheckpointStore);
  });

  test("the in-memory fallback honours the configured cap", async () => {
    const { sandbox } = recordingSandbox({ exitCode: 1 });
    const store = (await buildCheckpointStore(
      { enabled: true, maxCheckpoints: 2 },
      deps(sandbox),
    ))!;
    store.begin("s1", "a", 0);
    store.begin("s1", "b", 0);
    store.begin("s1", "c", 0);
    expect(store.list("s1").map((c) => c.turnNumber)).toEqual([1, 2]);
  });
});
