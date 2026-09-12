import { describe, expect, test } from "bun:test";
import { SandboxUnavailableError } from "../../../src/sandbox/types";
import { GitDiffTool } from "../../../src/tools/git/diff";
import { GitLogTool } from "../../../src/tools/git/log";
import { GitStatusTool } from "../../../src/tools/git/status";
import type { Tool } from "../../../src/tools/types";
import { recordingSandbox, throwingSandbox } from "../../git/helpers";

const ctx = { projectDir: "/proj", abortSignal: new AbortController().signal };

describe("GitStatusTool", () => {
  test("is a read tool (not mutating) and formats parsed status", async () => {
    const { sandbox, calls } = recordingSandbox({
      exitCode: 0,
      stdout: "## main...origin/main [ahead 1, behind 0]\nA  a.ts\n",
    });
    const tool: Tool = new GitStatusTool(sandbox);
    expect(tool.name).toBe("git_status");
    expect(tool.mutates).toBeUndefined();
    const r = await tool.run({}, ctx);
    expect(calls[0]!.command).toBe("git status --porcelain=v1 --branch");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("branch: main (ahead 1, behind 0)");
    expect(r.output).toContain("staged:    a.ts (added)");
  });

  test("sandbox unavailable → ok:false with the message", async () => {
    const tool = new GitStatusTool(throwingSandbox(new SandboxUnavailableError("down")));
    const r = await tool.run({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("down");
  });
});

describe("GitDiffTool", () => {
  test("unstaged by default; empty diff → 'no changes'", async () => {
    const { sandbox, calls } = recordingSandbox({ exitCode: 0, stdout: "" });
    const r = await new GitDiffTool(sandbox).run({}, ctx);
    expect(calls[0]!.command).toBe("git diff");
    expect(r).toMatchObject({ ok: true, output: "no changes" });
  });
  test("staged + path filter builds the right argv", async () => {
    const { sandbox, calls } = recordingSandbox({ exitCode: 0, stdout: "diff --git ..." });
    const r = await new GitDiffTool(sandbox).run({ staged: true, paths: ["src/a.ts"] }, ctx);
    expect(calls[0]!.command).toBe("git diff --staged -- src/a.ts");
    expect(r.output).toContain("diff --git");
  });
});

describe("GitLogTool", () => {
  test("defaults to 20, clamps to 100", async () => {
    const { sandbox, calls } = recordingSandbox({ exitCode: 0, stdout: "abc123 first" });
    await new GitLogTool(sandbox).run({}, ctx);
    expect(calls[0]!.command).toBe("git log --oneline -n 20");
    const { sandbox: s2, calls: c2 } = recordingSandbox({ exitCode: 0, stdout: "x" });
    await new GitLogTool(s2).run({ limit: 999 }, ctx);
    expect(c2[0]!.command).toBe("git log --oneline -n 100");
  });
  test("non-zero exit surfaces git's stderr", async () => {
    const { sandbox } = recordingSandbox({ exitCode: 128, stderr: "fatal: bad revision" });
    const r = await new GitLogTool(sandbox).run({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("fatal: bad revision");
  });
});
