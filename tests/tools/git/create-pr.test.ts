import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/sandbox/types";
import { CreatePrTool } from "../../../src/tools/git/create-pr";
import { scriptedSandbox } from "../../git/helpers";

const ctx = { projectDir: "/proj", abortSignal: new AbortController().signal };

// Routes shared by the happy-path tests. `@{u}` and `pr create` are matched before the
// generic `rev-parse`/`symbolic-ref` reads so substring routing stays unambiguous.
function happyRoutes(
  branch: string,
  upstreamExit: number,
): { match: string; result: Partial<ExecResult> }[] {
  return [
    { match: "@{u}", result: { exitCode: upstreamExit } },
    { match: "rev-parse --abbrev-ref HEAD", result: { exitCode: 0, stdout: `${branch}\n` } },
    {
      match: "symbolic-ref refs/remotes/origin/HEAD",
      result: { exitCode: 0, stdout: "refs/remotes/origin/main\n" },
    },
    { match: "push", result: { exitCode: 0 } },
    { match: "pr create", result: { exitCode: 0, stdout: "https://github.com/o/r/pull/7\n" } },
  ];
}

describe("CreatePrTool", () => {
  test("is mutating; refuses on the default branch", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "rev-parse --abbrev-ref HEAD", result: { exitCode: 0, stdout: "main\n" } },
      {
        match: "symbolic-ref refs/remotes/origin/HEAD",
        result: { exitCode: 0, stdout: "refs/remotes/origin/main\n" },
      },
    ]);
    const tool = new CreatePrTool(sandbox);
    expect(tool.mutates).toBe(true);
    const r = await tool.run({ title: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("default branch");
    expect(calls.some((c) => c.command.includes("pr create"))).toBe(false);
  });

  test("no upstream → pushes -u, then creates the PR; title/body are single args", async () => {
    const { sandbox, calls } = scriptedSandbox(happyRoutes("feat/x", 128));
    const r = await new CreatePrTool(sandbox).run({ title: "My PR", body: "line1\nline2" }, ctx);
    expect(calls.some((c) => c.command === "git push -u origin feat/x")).toBe(true);
    const create = calls.find((c) => c.command.includes("pr create"));
    expect(create?.command).toBe("gh pr create --title 'My PR' --body 'line1\nline2'");
    expect(r).toMatchObject({ ok: true, output: "https://github.com/o/r/pull/7" });
  });

  test("existing upstream → no push; draft + base flags forwarded", async () => {
    const { sandbox, calls } = scriptedSandbox(happyRoutes("feat/x", 0));
    await new CreatePrTool(sandbox).run({ title: "T", base: "develop", draft: true }, ctx);
    expect(calls.some((c) => c.command.startsWith("git push"))).toBe(false);
    const create = calls.find((c) => c.command.includes("pr create"));
    expect(create?.command).toBe("gh pr create --title T --base develop --draft");
  });

  test("missing title → guard error", async () => {
    const { sandbox } = scriptedSandbox([]);
    const r = await new CreatePrTool(sandbox).run({ title: "  " }, ctx);
    expect(r.ok).toBe(false);
  });

  test("gh failure surfaces gh's stderr (e.g. auth)", async () => {
    const routes = happyRoutes("feat/x", 0);
    routes[routes.length - 1] = {
      match: "pr create",
      result: {
        exitCode: 1,
        stderr: "gh: To get started with GitHub CLI, please run: gh auth login",
      },
    };
    const { sandbox } = scriptedSandbox(routes);
    const r = await new CreatePrTool(sandbox).run({ title: "T" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("gh auth login");
  });
});
