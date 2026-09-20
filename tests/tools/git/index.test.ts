import { describe, expect, test } from "bun:test";
import { buildGitTools } from "../../../src/tools/git/index";
import { scriptedSandbox } from "../../git/helpers";

const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort();

describe("buildGitTools", () => {
  test("non-repo → initialization and Git tools are available, with no warnings", async () => {
    const { tools, warnings } = await buildGitTools(
      { sandbox: scriptedSandbox([]).sandbox, projectDir: "/proj" },
      () => "/usr/bin/gh",
    );
    expect(names(tools)).toContain("git_init");
    expect(names(tools)).toContain("create_github_repo");
    expect(warnings).toEqual([]);
  });

  test("Git tool roster has all nine operations", async () => {
    const { tools, warnings } = await buildGitTools(
      { sandbox: scriptedSandbox([]).sandbox, projectDir: "/proj" },
      () => "/usr/bin/gh",
    );
    expect(names(tools)).toEqual([
      "create_github_repo",
      "create_pr",
      "git_add",
      "git_commit",
      "git_diff",
      "git_init",
      "git_log",
      "git_push",
      "git_status",
    ]);
    expect(warnings).toEqual([]);
  });

  test("missing gh does not hide GitHub tools or emit a startup warning", async () => {
    const { tools, warnings } = await buildGitTools(
      { sandbox: scriptedSandbox([]).sandbox, projectDir: "/proj" },
      () => null,
    );
    expect(names(tools)).toContain("create_pr");
    expect(names(tools)).toContain("create_github_repo");
    expect(tools.length).toBe(9);
    expect(warnings).toEqual([]);
  });
});
