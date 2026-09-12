import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitAddTool } from "../../../src/tools/git/add";
import { GitCommitTool } from "../../../src/tools/git/commit";
import { GitPushTool } from "../../../src/tools/git/push";
import { recordingSandbox, scriptedSandbox } from "../../git/helpers";

const ctx = { projectDir: "/proj", abortSignal: new AbortController().signal };

describe("GitAddTool", () => {
  test("mutating; all:true → git add -A", async () => {
    const { sandbox, calls } = recordingSandbox({ exitCode: 0 });
    const tool = new GitAddTool(sandbox);
    expect(tool.mutates).toBe(true);
    const r = await tool.run({ all: true }, ctx);
    expect(calls.some((c) => c.command === "git add -A")).toBe(true);
    expect(r).toMatchObject({ ok: true });
  });
  test("paths are staged after a -- separator", async () => {
    const { sandbox, calls } = recordingSandbox({ exitCode: 0 });
    await new GitAddTool(sandbox).run({ paths: ["a b.ts"] }, ctx);
    expect(calls.some((c) => c.command === "git add -- 'a b.ts'")).toBe(true);
  });
  test("neither paths nor all → guard error, no shell-out", async () => {
    const { sandbox, calls } = recordingSandbox({ exitCode: 0 });
    const r = await new GitAddTool(sandbox).run({}, ctx);
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
  test("no .gitignore (check-ignore exit 1) → prepends the seeded-excludes note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-add-"));
    await mkdir(join(dir, ".git", "info"), { recursive: true });
    const { sandbox } = scriptedSandbox([
      { match: "check-ignore", result: { exitCode: 1 } },
      { match: "rev-parse", result: { exitCode: 0, stdout: ".git/info/exclude\n" } },
      { match: "add -A", result: { exitCode: 0 } },
    ]);
    const r = await new GitAddTool(sandbox).run(
      { all: true },
      { projectDir: dir, abortSignal: new AbortController().signal },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("seeded .git/info/exclude");
    expect(r.output).toContain("staged all changes");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("GitCommitTool", () => {
  test("stage:'all' stages then commits; message is one quoted arg", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "add -A", result: { exitCode: 0 } },
      {
        match: "commit -m",
        result: { exitCode: 0, stdout: "[feat/x abc1234] hi\n 1 file changed" },
      },
    ]);
    const r = await new GitCommitTool(sandbox).run(
      { message: "fix: it's broken", stage: "all" },
      ctx,
    );
    expect(calls.some((c) => c.command === "git add -A")).toBe(true);
    expect(calls.some((c) => c.command === "git commit -m 'fix: it'\\''s broken'")).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("abc1234");
  });
  test("stage omitted with nothing staged → guard error", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "diff --cached --quiet", result: { exitCode: 0 } }, // exit 0 = nothing staged
    ]);
    const r = await new GitCommitTool(sandbox).run({ message: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("nothing staged");
    expect(calls.some((c) => c.command.startsWith("git commit"))).toBe(false);
  });
  test("stage omitted with staged changes → commits", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "diff --cached --quiet", result: { exitCode: 1 } }, // exit 1 = has staged changes
      { match: "commit -m", result: { exitCode: 0, stdout: "[main def5678] y" } },
    ]);
    const r = await new GitCommitTool(sandbox).run({ message: "y" }, ctx);
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.command === "git commit -m y")).toBe(true);
  });
  test("empty message → guard error", async () => {
    const { sandbox } = recordingSandbox({});
    const r = await new GitCommitTool(sandbox).run({ message: "  " }, ctx);
    expect(r.ok).toBe(false);
  });
  test("stage:'all' with no .gitignore → seeds excludes and prepends the note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-commit-"));
    await mkdir(join(dir, ".git", "info"), { recursive: true });
    const { sandbox } = scriptedSandbox([
      { match: "check-ignore", result: { exitCode: 1 } },
      { match: "rev-parse", result: { exitCode: 0, stdout: ".git/info/exclude\n" } },
      { match: "add -A", result: { exitCode: 0 } },
      { match: "commit -m", result: { exitCode: 0, stdout: "[main abc1234] x" } },
    ]);
    const r = await new GitCommitTool(sandbox).run(
      { message: "x", stage: "all" },
      { projectDir: dir, abortSignal: new AbortController().signal },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("seeded .git/info/exclude");
    expect(r.output).toContain("abc1234");
    const written = await Bun.file(join(dir, ".git", "info", "exclude")).text();
    expect(written).toContain("node_modules/");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("GitPushTool", () => {
  test("no upstream → sets -u origin <branch>", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "rev-parse --abbrev-ref HEAD", result: { exitCode: 0, stdout: "feat/x\n" } },
      { match: "@{u}", result: { exitCode: 128 } },
      { match: "push", result: { exitCode: 0, stderr: "Branch set up to track" } },
    ]);
    const r = await new GitPushTool(sandbox).run({}, ctx);
    expect(calls.some((c) => c.command === "git push -u origin feat/x")).toBe(true);
    expect(r.ok).toBe(true);
  });
  test("existing upstream → plain push", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "rev-parse --abbrev-ref HEAD", result: { exitCode: 0, stdout: "feat/x\n" } },
      { match: "@{u}", result: { exitCode: 0, stdout: "origin/feat/x" } },
      { match: "push", result: { exitCode: 0, stderr: "Everything up-to-date" } },
    ]);
    await new GitPushTool(sandbox).run({}, ctx);
    expect(calls.some((c) => c.command === "git push")).toBe(true);
  });
  test("force maps to --force-with-lease, never bare --force", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "rev-parse --abbrev-ref HEAD", result: { exitCode: 0, stdout: "feat/x\n" } },
      { match: "@{u}", result: { exitCode: 0 } },
      { match: "push", result: { exitCode: 0 } },
    ]);
    await new GitPushTool(sandbox).run({ force: true }, ctx);
    const push = calls.find((c) => c.command.startsWith("git push"));
    expect(push?.command).toContain("--force-with-lease");
    expect(push?.command).not.toMatch(/--force(?!-with-lease)/);
  });
  test("detached HEAD with no upstream → guard error, no push", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "@{u}", result: { exitCode: 128 } },
      { match: "abbrev-ref HEAD", result: { exitCode: 0, stdout: "HEAD\n" } },
    ]);
    const r = await new GitPushTool(sandbox).run({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("detached HEAD");
    expect(calls.some((c) => c.command === "git push" || c.command.startsWith("git push -u"))).toBe(
      false,
    );
  });
});
