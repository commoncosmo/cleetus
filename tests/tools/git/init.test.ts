import { describe, expect, test } from "bun:test";
import { GitInitTool } from "../../../src/tools/git/init";
import { scriptedSandbox } from "../../git/helpers";

const ctx = { projectDir: "/proj", abortSignal: new AbortController().signal };

describe("GitInitTool", () => {
  test("initializes only after confirming the project is not already a repository", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "rev-parse --is-inside-work-tree", result: { exitCode: 128 } },
      { match: "git init", result: { exitCode: 0, stdout: "Initialized empty Git repository\n" } },
    ]);
    const result = await new GitInitTool(sandbox).run({ initialBranch: "main" }, ctx);
    expect(result).toMatchObject({ ok: true, output: "Initialized empty Git repository" });
    expect(calls.map((call) => call.command)).toEqual([
      "git rev-parse --is-inside-work-tree",
      "git init --initial-branch=main",
    ]);
  });

  test("refuses to reinitialize an existing repository", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "rev-parse --is-inside-work-tree", result: { exitCode: 0, stdout: "true\n" } },
    ]);
    const result = await new GitInitTool(sandbox).run({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("already exists");
    expect(calls).toHaveLength(1);
  });

  test("rejects an empty initial branch before calling Git", async () => {
    const { sandbox, calls } = scriptedSandbox([]);
    const result = await new GitInitTool(sandbox).run({ initialBranch: " " }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("must not be empty");
    expect(calls).toEqual([]);
  });
});
