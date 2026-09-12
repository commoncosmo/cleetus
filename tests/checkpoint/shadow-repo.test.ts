import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowRepo } from "../../src/checkpoint/shadow-repo";
import { recordingSandbox, scriptedSandbox } from "../git/helpers";

const proj = () => mkdtemp(join(tmpdir(), "shadow-"));

describe("ShadowRepo.snapshot", () => {
  test("commits and returns the new HEAD sha when the tree changed", async () => {
    const dir = await proj();
    const shadow = join(dir, ".cleetus", "checkpoints.git");
    // tree != HEAD^{tree} → commit path. rev-parse HEAD (the LAST call) returns the new sha.
    const { sandbox, calls } = scriptedSandbox([
      { match: "write-tree", result: { stdout: "newtree\n" } },
      { match: "rev-parse --verify --quiet", result: { stdout: "oldtree\n" } },
      { match: "rev-parse HEAD", result: { stdout: "commitsha\n" } },
    ]);
    const repo = new ShadowRepo(sandbox, dir);
    expect(await repo.snapshot()).toBe("commitsha");
    const joined = calls.map((c) => c.command);
    // Every git call carries the shadow git-dir + project work-tree.
    expect(joined.every((c) => c.includes(`--git-dir ${shadow}`))).toBe(true);
    expect(joined.every((c) => c.includes(`--work-tree ${dir}`))).toBe(true);
    expect(joined.some((c) => c.includes("add -A"))).toBe(true);
    expect(joined.some((c) => c.includes("commit") && c.includes("user.name=cleetus"))).toBe(true);
  });

  test("reuses HEAD and skips the commit when the tree is unchanged", async () => {
    const dir = await proj();
    const { sandbox, calls } = scriptedSandbox([
      { match: "write-tree", result: { stdout: "sametree\n" } },
      { match: "rev-parse --verify --quiet", result: { stdout: "sametree\n" } },
      { match: "rev-parse HEAD", result: { stdout: "headsha\n" } },
    ]);
    const repo = new ShadowRepo(sandbox, dir);
    expect(await repo.snapshot()).toBe("headsha");
    expect(calls.some((c) => c.command.includes("commit"))).toBe(false);
  });

  test("mirrors the checkpoint repository outside the project after a snapshot", async () => {
    const dir = await proj();
    const shadow = join(dir, ".cleetus", "checkpoints.git");
    const mirror = join(await proj(), "recovery", "checkpoints.git");
    await mkdir(shadow, { recursive: true });
    await writeFile(join(shadow, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(shadow, "forensic-marker"), "survives");
    const { sandbox } = scriptedSandbox([
      { match: "write-tree", result: { stdout: "sametree\n" } },
      { match: "rev-parse --verify --quiet", result: { stdout: "sametree\n" } },
      { match: "rev-parse HEAD", result: { stdout: "headsha\n" } },
    ]);

    const repo = new ShadowRepo(sandbox, dir, mirror);
    expect(await repo.snapshot()).toBe("headsha");
    expect(await readFile(join(mirror, "forensic-marker"), "utf8")).toBe("survives");
  });

  test("does not recopy immutable Git objects already present in the mirror", async () => {
    const dir = await proj();
    const shadow = join(dir, ".cleetus", "checkpoints.git");
    const mirror = join(await proj(), "recovery", "checkpoints.git");
    const objectPath = join("objects", "aa", "object");
    await mkdir(join(shadow, "objects", "aa"), { recursive: true });
    await mkdir(join(mirror, "objects", "aa"), { recursive: true });
    await writeFile(join(shadow, objectPath), "source-copy");
    await writeFile(join(mirror, objectPath), "existing-copy");
    const { sandbox } = scriptedSandbox([
      { match: "write-tree", result: { stdout: "sametree\n" } },
      { match: "rev-parse --verify --quiet", result: { stdout: "sametree\n" } },
      { match: "rev-parse HEAD", result: { stdout: "headsha\n" } },
    ]);

    expect(await new ShadowRepo(sandbox, dir, mirror).snapshot()).toBe("headsha");
    expect(await readFile(join(mirror, objectPath), "utf8")).toBe("existing-copy");
  });

  test("returns null when add fails", async () => {
    const dir = await proj();
    const { sandbox } = scriptedSandbox([{ match: "add -A", result: { exitCode: 1 } }]);
    const repo = new ShadowRepo(sandbox, dir);
    expect(await repo.snapshot()).toBeNull();
  });

  test("returns null when the commit fails (e.g. nothing to commit, no HEAD)", async () => {
    const dir = await proj();
    const { sandbox } = scriptedSandbox([
      { match: "write-tree", result: { stdout: "t\n" } },
      { match: "rev-parse --verify --quiet", result: { exitCode: 1 } },
      { match: "commit", result: { exitCode: 1 } },
    ]);
    const repo = new ShadowRepo(sandbox, dir);
    expect(await repo.snapshot()).toBeNull();
  });
});

describe("ShadowRepo.restore", () => {
  test("runs read-tree → checkout-index → clean and counts changes", async () => {
    const dir = await proj();
    // diff --name-status: one Added (→ deleted on rewind), one Modified (→ restored).
    const { sandbox, calls } = scriptedSandbox([
      { match: "write-tree", result: { stdout: "curtree\n" } },
      { match: "diff --name-status", result: { stdout: "A\tnew.ts\nM\told.ts\n" } },
    ]);
    const repo = new ShadowRepo(sandbox, dir);
    const counts = await repo.restore("targetsha");
    expect(counts).toEqual({ filesRestored: 1, filesDeleted: 1 });
    const joined = calls.map((c) => c.command);
    expect(joined.some((c) => c.includes("read-tree targetsha"))).toBe(true);
    expect(joined.some((c) => c.includes("checkout-index -a -f"))).toBe(true);
    expect(joined.some((c) => c.includes("clean -fd"))).toBe(true);
  });
});

describe("ShadowRepo.ensureRepo", () => {
  test("snapshot triggers ensureRepo (the first call inits when HEAD is absent)", async () => {
    const dir = await proj();
    // HEAD won't exist (git init is mocked), so init runs.
    const { sandbox, calls } = recordingSandbox();
    const repo = new ShadowRepo(sandbox, dir);
    await repo.snapshot();
    expect(calls.some((c) => c.command.includes("init"))).toBe(true);
  });

  test("seeds info/exclude with deps/build dirs so rewind can't clobber them", async () => {
    const dir = await proj();
    const { sandbox } = recordingSandbox();
    const repo = new ShadowRepo(sandbox, dir);
    await repo.snapshot();
    const exclude = await Bun.file(
      join(dir, ".cleetus", "checkpoints.git", "info", "exclude"),
    ).text();
    expect(exclude).toContain(".cleetus/");
    expect(exclude).toContain("node_modules/");
  });
});
