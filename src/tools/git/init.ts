import { isGitRepo } from "../../git/repo";
import { runGit } from "../../git/run";
import type { Sandbox } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import { runFailure, sandboxFailure, toolFail } from "./shared";

interface InitArgs {
  initialBranch?: string;
}

/** Initialize version control at the current project root. */
export class GitInitTool implements Tool {
  name = "git_init";
  mutates = true;
  description =
    "Initialize a non-bare Git repository at the project root. Optionally set `initialBranch` " +
    '(defaults to Git\'s configured default, usually "main").';
  parameters = {
    type: "object",
    properties: {
      initialBranch: {
        type: "string",
        description: "Optional name for the initial branch, such as 'main'.",
      },
    },
    additionalProperties: false,
  };

  constructor(private readonly sandbox: Sandbox) {}

  serialize(args: unknown): string {
    const { initialBranch } = args as InitArgs;
    return initialBranch ? `git init --initial-branch ${initialBranch}` : "git init";
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { initialBranch } = args as InitArgs;
    if (initialBranch != null && initialBranch.trim() === "") {
      return toolFail("git_init initialBranch must not be empty");
    }
    try {
      if (await isGitRepo(this.sandbox, ctx)) {
        return toolFail("a Git repository already exists at the project root");
      }
      const argv = ["init"];
      if (initialBranch) argv.push(`--initial-branch=${initialBranch}`);
      const r = await runGit(this.sandbox, argv, ctx);
      const fail = runFailure("git init", r);
      if (fail) return fail;
      return { ok: true, output: r.stdout.trim() || "initialized Git repository" };
    } catch (e) {
      return sandboxFailure(e);
    }
  }
}
