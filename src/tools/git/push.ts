import { currentBranch } from "../../git/repo";
import { runGit } from "../../git/run";
import type { Sandbox } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import { capOutput, runFailure, sandboxFailure, toolFail } from "./shared";

interface PushArgs {
  setUpstream?: boolean;
  force?: boolean;
}

export class GitPushTool implements Tool {
  name = "git_push";
  mutates = true;
  description =
    "Push the current branch to its remote. Sets the upstream automatically when missing. " +
    "Set force:true for a safe force push (--force-with-lease).";
  parameters = {
    type: "object",
    properties: {
      setUpstream: {
        type: "boolean",
        description: "Usually leave unset — the upstream is set automatically when missing.",
      },
      force: { type: "boolean" },
    },
    additionalProperties: false,
  };

  constructor(private readonly sandbox: Sandbox) {}

  serialize(args: unknown): string {
    return `git push${(args as PushArgs).force ? " --force-with-lease" : ""}`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as PushArgs;
    try {
      let setUpstream = a.setUpstream;
      if (setUpstream === undefined) {
        const up = await runGit(
          this.sandbox,
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
          ctx,
        );
        setUpstream = up.exitCode !== 0; // no upstream → set it
      }

      const argv = ["push"];
      if (a.force) argv.push("--force-with-lease");
      if (setUpstream) {
        const branch = await currentBranch(this.sandbox, ctx);
        if (!branch) return toolFail("cannot set upstream: not on a branch (detached HEAD)");
        argv.push("-u", "origin", branch);
      }

      const r = await runGit(this.sandbox, argv, ctx);
      const fail = runFailure("git push", r);
      if (fail) return fail;
      return { ok: true, output: capOutput(r.stderr.trim() || r.stdout.trim() || "pushed") };
    } catch (e) {
      return sandboxFailure(e);
    }
  }
}
