import { describe, expect, test } from "bun:test";
import { buildGitTools } from "../../../src/tools/git/index";
import { scriptedSandbox } from "../../git/helpers";

const repoSandbox = () =>
  scriptedSandbox([
    { match: "rev-parse --is-inside-work-tree", result: { exitCode: 0, stdout: "true\n" } },
  ]).sandbox;

const nonRepoSandbox = () =>
  scriptedSandbox([
    { match: "rev-parse --is-inside-work-tree", result: { exitCode: 128, stderr: "not a repo" } },
  ]).sandbox;

const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort();

describe("buildGitTools", () => {
  test("non-repo → no tools, no warnings", async () => {
    const { tools, warnings } = await buildGitTools(
      { sandbox: nonRepoSandbox(), projectDir: "/proj" },
      () => "/usr/bin/gh",
    );
    expect(tools).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("repo with gh → all seven tools", async () => {
    const { tools, warnings } = await buildGitTools(
      { sandbox: repoSandbox(), projectDir: "/proj" },
      () => "/usr/bin/gh",
    );
    expect(names(tools)).toEqual([
      "create_pr",
      "git_add",
      "git_commit",
      "git_diff",
      "git_log",
      "git_push",
      "git_status",
    ]);
    expect(warnings).toEqual([]);
  });

  test("repo without gh → six tools + a warning, no create_pr", async () => {
    const { tools, warnings } = await buildGitTools(
      { sandbox: repoSandbox(), projectDir: "/proj" },
      () => null,
    );
    expect(names(tools)).not.toContain("create_pr");
    expect(tools.length).toBe(6);
    expect(warnings).toEqual(["create_pr unavailable: 'gh' not found"]);
  });

  test("ACP-style registration keeps git tools available for a later session cwd", async () => {
    const { tools } = await buildGitTools(
      {
        sandbox: nonRepoSandbox(),
        projectDir: "/launch-directory",
        registerForAnyProject: true,
      },
      () => "/usr/bin/gh",
    );
    expect(names(tools)).toContain("git_status");
  });
});
