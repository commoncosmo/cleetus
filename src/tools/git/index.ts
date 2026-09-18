import { isGitRepo } from "../../git/repo";
import type { GitRunContext } from "../../git/run";
import type { Sandbox } from "../../sandbox/types";
import type { Tool } from "../types";
import { GitAddTool } from "./add";
import { GitCommitTool } from "./commit";
import { CreatePrTool } from "./create-pr";
import { GitDiffTool } from "./diff";
import { GitLogTool } from "./log";
import { GitPushTool } from "./push";
import { GitStatusTool } from "./status";

export interface BuiltGitTools {
  tools: Tool[];
  warnings: string[];
}

type Which = (bin: string) => string | null;

/**
 * Build the git/PR tools to register, or none when projectDir is not a git repo.
 * `create_pr` checks for `gh` only when it is invoked, so an optional GitHub CLI
 * dependency never produces an unrelated startup warning. `which` is injected for
 * deterministic tests, mirroring run-tests' detect().
 */
export async function buildGitTools(
  deps: { sandbox: Sandbox; projectDir: string; registerForAnyProject?: boolean },
  which: Which = (b) => Bun.which(b),
): Promise<BuiltGitTools> {
  const ctx: GitRunContext = {
    projectDir: deps.projectDir,
    abortSignal: new AbortController().signal,
  };
  if (!deps.registerForAnyProject && !(await isGitRepo(deps.sandbox, ctx))) {
    return { tools: [], warnings: [] };
  }

  const tools: Tool[] = [
    new GitStatusTool(deps.sandbox),
    new GitDiffTool(deps.sandbox),
    new GitLogTool(deps.sandbox),
    new GitAddTool(deps.sandbox),
    new GitCommitTool(deps.sandbox),
    new GitPushTool(deps.sandbox),
  ];
  tools.push(new CreatePrTool(deps.sandbox, which));
  return { tools, warnings: [] };
}
