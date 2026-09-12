import { describe, expect, test } from "bun:test";
import { currentBranch, defaultBranch, isGitRepo } from "../../src/git/repo";
import { SandboxUnavailableError } from "../../src/sandbox/types";
import { scriptedSandbox, throwingSandbox } from "./helpers";

const ctx = { projectDir: "/proj", abortSignal: new AbortController().signal };

describe("isGitRepo", () => {
  test("true when rev-parse reports a work tree", async () => {
    const { sandbox } = scriptedSandbox([
      { match: "rev-parse --is-inside-work-tree", result: { exitCode: 0, stdout: "true\n" } },
    ]);
    expect(await isGitRepo(sandbox, ctx)).toBe(true);
  });
  test("false when rev-parse fails (not a repo / git missing)", async () => {
    const { sandbox } = scriptedSandbox([
      {
        match: "rev-parse --is-inside-work-tree",
        result: { exitCode: 128, stderr: "not a git repo" },
      },
    ]);
    expect(await isGitRepo(sandbox, ctx)).toBe(false);
  });
  test("false when the sandbox is unavailable", async () => {
    const sandbox = throwingSandbox(new SandboxUnavailableError("no sandbox"));
    expect(await isGitRepo(sandbox, ctx)).toBe(false);
  });
});

describe("currentBranch", () => {
  test("returns the branch name", async () => {
    const { sandbox } = scriptedSandbox([
      { match: "rev-parse --abbrev-ref HEAD", result: { exitCode: 0, stdout: "feat/x\n" } },
    ]);
    expect(await currentBranch(sandbox, ctx)).toBe("feat/x");
  });
  test("null on detached HEAD", async () => {
    const { sandbox } = scriptedSandbox([
      { match: "rev-parse --abbrev-ref HEAD", result: { exitCode: 0, stdout: "HEAD\n" } },
    ]);
    expect(await currentBranch(sandbox, ctx)).toBeNull();
  });
});

describe("defaultBranch", () => {
  test("reads origin/HEAD when present", async () => {
    const { sandbox } = scriptedSandbox([
      {
        match: "symbolic-ref refs/remotes/origin/HEAD",
        result: { exitCode: 0, stdout: "refs/remotes/origin/main\n" },
      },
    ]);
    expect(await defaultBranch(sandbox, ctx)).toBe("main");
  });
  test("falls back to master when origin/HEAD is absent but refs/heads/master exists", async () => {
    const { sandbox } = scriptedSandbox([
      { match: "symbolic-ref refs/remotes/origin/HEAD", result: { exitCode: 128 } },
      { match: "show-ref --verify --quiet refs/heads/main", result: { exitCode: 1 } },
      { match: "show-ref --verify --quiet refs/heads/master", result: { exitCode: 0 } },
    ]);
    expect(await defaultBranch(sandbox, ctx)).toBe("master");
  });
  test("defaults to main when nothing resolves", async () => {
    const { sandbox } = scriptedSandbox([
      { match: "symbolic-ref refs/remotes/origin/HEAD", result: { exitCode: 128 } },
      { match: "show-ref", result: { exitCode: 1 } },
    ]);
    expect(await defaultBranch(sandbox, ctx)).toBe("main");
  });
});
