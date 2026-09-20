import { describe, expect, test } from "bun:test";
import { CreateGitHubRepoTool } from "../../../src/tools/git/create-repo";
import { scriptedSandbox } from "../../git/helpers";

const ctx = { projectDir: "/proj", abortSignal: new AbortController().signal };

describe("CreateGitHubRepoTool", () => {
  test("creates a specifically visible repository, adds origin, and pushes", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "rev-parse --is-inside-work-tree", result: { exitCode: 0, stdout: "true\n" } },
      { match: "rev-parse --verify HEAD", result: { exitCode: 0, stdout: "abc123\n" } },
      { match: "git remote", result: { exitCode: 0 } },
      {
        match: "gh repo create",
        result: { exitCode: 0, stdout: "https://github.com/commoncosmo/cleetus-site\n" },
      },
    ]);
    const result = await new CreateGitHubRepoTool(sandbox, () => "/usr/bin/gh").run(
      {
        name: "commoncosmo/cleetus-site",
        visibility: "public",
        description: "Cleetus site",
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      output: "https://github.com/commoncosmo/cleetus-site",
    });
    expect(calls.map((call) => call.command)).toEqual([
      "git rev-parse --is-inside-work-tree",
      "git rev-parse --verify HEAD",
      "git remote",
      "gh repo create commoncosmo/cleetus-site --public --source . --remote origin --push --description 'Cleetus site'",
    ]);
  });

  test("refuses to replace an existing origin", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "rev-parse --is-inside-work-tree", result: { exitCode: 0, stdout: "true\n" } },
      { match: "rev-parse --verify HEAD", result: { exitCode: 0, stdout: "abc123\n" } },
      {
        match: "git remote",
        result: { exitCode: 0, stdout: "origin\n" },
      },
    ]);
    const result = await new CreateGitHubRepoTool(sandbox, () => "/usr/bin/gh").run(
      { name: "cleetus-site", visibility: "private" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("refusing to replace");
    expect(calls).toHaveLength(3);
  });

  test("requires an initialized repository and authenticated GitHub CLI", async () => {
    const { sandbox, calls } = scriptedSandbox([]);
    const missingGh = await new CreateGitHubRepoTool(sandbox, () => null).run(
      { name: "cleetus-site", visibility: "private" },
      ctx,
    );
    expect(missingGh.errorMessage).toContain("gh auth login");
    expect(calls).toEqual([]);

    const { sandbox: nonRepo } = scriptedSandbox([
      { match: "rev-parse --is-inside-work-tree", result: { exitCode: 128 } },
    ]);
    const missingRepo = await new CreateGitHubRepoTool(nonRepo, () => "/usr/bin/gh").run(
      { name: "cleetus-site", visibility: "private" },
      ctx,
    );
    expect(missingRepo.errorMessage).toContain("initialize a Git repository");
  });

  test("requires an initial commit before creating a repository to push", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "rev-parse --is-inside-work-tree", result: { exitCode: 0, stdout: "true\n" } },
      { match: "rev-parse --verify HEAD", result: { exitCode: 128 } },
    ]);
    const result = await new CreateGitHubRepoTool(sandbox, () => "/usr/bin/gh").run(
      { name: "cleetus-site", visibility: "private" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("commit the project");
    expect(calls).toHaveLength(2);
  });

  test("requires a safe repository name and explicit visibility", async () => {
    const { sandbox, calls } = scriptedSandbox([]);
    const tool = new CreateGitHubRepoTool(sandbox, () => "/usr/bin/gh");
    expect((await tool.run({ name: "owner/repo; rm -rf /", visibility: "public" }, ctx)).ok).toBe(
      false,
    );
    expect((await tool.run({ name: "cleetus-site" }, ctx)).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
