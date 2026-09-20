import type { Sandbox } from "../../sandbox/types";
import type { Tool } from "../types";
import { GitAddTool } from "./add";
import { GitCommitTool } from "./commit";
import { CreatePrTool } from "./create-pr";
import { CreateGitHubRepoTool } from "./create-repo";
import { GitDiffTool } from "./diff";
import { GitInitTool } from "./init";
import { GitLogTool } from "./log";
import { GitPushTool } from "./push";
import { GitStatusTool } from "./status";

export interface BuiltGitTools {
  tools: Tool[];
  warnings: string[];
}

type Which = (bin: string) => string | null;

/**
 * Build the Git/GitHub tools. They are registered before initialization so one session can
 * initialize, commit, and publish a newly scaffolded project. `create_pr` and
 * `create_github_repo` check for `gh` only when invoked, so an optional GitHub CLI
 * dependency never produces an unrelated startup warning. `which` is injected for
 * deterministic tests, mirroring run-tests' detect().
 */
export async function buildGitTools(
  deps: { sandbox: Sandbox; projectDir: string },
  which: Which = (b) => Bun.which(b),
): Promise<BuiltGitTools> {
  const tools: Tool[] = [
    new GitInitTool(deps.sandbox),
    new GitStatusTool(deps.sandbox),
    new GitDiffTool(deps.sandbox),
    new GitLogTool(deps.sandbox),
    new GitAddTool(deps.sandbox),
    new GitCommitTool(deps.sandbox),
    new GitPushTool(deps.sandbox),
  ];
  tools.push(new CreatePrTool(deps.sandbox, which));
  tools.push(new CreateGitHubRepoTool(deps.sandbox, which));
  return { tools, warnings: [] };
}
