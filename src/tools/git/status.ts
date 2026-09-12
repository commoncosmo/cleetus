import { formatStatus, parseStatus } from "../../git/parse";
import { runGit } from "../../git/run";
import type { Sandbox } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import { runFailure, sandboxFailure } from "./shared";

export class GitStatusTool implements Tool {
  name = "git_status";
  description =
    "Show the working tree status: current branch, ahead/behind, and staged/unstaged/untracked files.";
  parameters = { type: "object", properties: {}, additionalProperties: false };

  constructor(private readonly sandbox: Sandbox) {}

  serialize(): string {
    return "git status";
  }

  async run(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
    let r: Awaited<ReturnType<typeof runGit>>;
    try {
      r = await runGit(this.sandbox, ["status", "--porcelain=v1", "--branch"], ctx);
    } catch (e) {
      return sandboxFailure(e);
    }
    const fail = runFailure("git status", r);
    if (fail) return fail;
    return { ok: true, output: formatStatus(parseStatus(r.stdout)) };
  }
}
