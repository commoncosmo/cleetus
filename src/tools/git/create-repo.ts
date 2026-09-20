import { isGitRepo } from "../../git/repo";
import { runGh, runGit } from "../../git/run";
import type { Sandbox } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import { capOutput, runFailure, sandboxFailure, toolFail } from "./shared";

type Visibility = "public" | "private" | "internal";

interface CreateGitHubRepoArgs {
  name?: string;
  visibility?: Visibility;
  description?: string;
}

type Which = (bin: string) => string | null;

function validRepoName(name: string): boolean {
  return /^(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})(?:\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99}))?)$/.test(
    name,
  );
}

/** Create a GitHub repository from the current repository and push its current branch. */
export class CreateGitHubRepoTool implements Tool {
  name = "create_github_repo";
  mutates = true;
  description =
    "Create a GitHub repository for this project with `gh`, add it as origin, and push the current " +
    "branch. Provide `name` as REPO or OWNER/REPO and explicitly choose `visibility`.";
  parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "GitHub repository name, optionally qualified as OWNER/REPO.",
      },
      visibility: { type: "string", enum: ["public", "private", "internal"] },
      description: { type: "string" },
    },
    required: ["name", "visibility"],
    additionalProperties: false,
  };

  constructor(
    private readonly sandbox: Sandbox,
    private readonly which: Which = (bin) => Bun.which(bin),
  ) {}

  serialize(args: unknown): string {
    const a = args as CreateGitHubRepoArgs;
    return `gh repo create ${a.name ?? ""} --${a.visibility ?? "private"} --source . --push`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as CreateGitHubRepoArgs;
    if (!a.name || !validRepoName(a.name)) {
      return toolFail(
        "create_github_repo needs a repository name like 'my-project' or 'owner/my-project'",
      );
    }
    if (!a.visibility || !["public", "private", "internal"].includes(a.visibility)) {
      return toolFail("create_github_repo needs visibility: 'public', 'private', or 'internal'");
    }
    if (!this.which("gh")) {
      return toolFail(
        "create_github_repo requires the GitHub CLI ('gh'), but it is not installed or not on PATH. " +
          "Install gh, run 'gh auth login', then try again.",
      );
    }

    try {
      if (!(await isGitRepo(this.sandbox, ctx))) {
        return toolFail(
          "initialize a Git repository and commit the project before creating a GitHub repository",
        );
      }
      const head = await runGit(this.sandbox, ["rev-parse", "--verify", "HEAD"], ctx);
      if (head.exitCode !== 0) {
        return toolFail("commit the project before creating and pushing a GitHub repository");
      }
      const remotes = await runGit(this.sandbox, ["remote"], ctx);
      const remoteFailure = runFailure("git remote", remotes);
      if (remoteFailure) return remoteFailure;
      if (remotes.stdout.split(/\r?\n/).some((remote) => remote === "origin")) {
        return toolFail("origin already exists; refusing to replace it");
      }

      const argv = [
        "repo",
        "create",
        a.name,
        `--${a.visibility}`,
        "--source",
        ".",
        "--remote",
        "origin",
        "--push",
      ];
      if (a.description !== undefined) argv.push("--description", a.description);
      const r = await runGh(this.sandbox, argv, ctx);
      const fail = runFailure("gh repo create", r);
      if (fail) return fail;
      return {
        ok: true,
        output: capOutput(r.stdout.trim() || "GitHub repository created and pushed"),
      };
    } catch (e) {
      return sandboxFailure(e);
    }
  }
}
