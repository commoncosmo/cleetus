import { currentBranch, defaultBranch } from "../../git/repo";
import { runGh, runGit } from "../../git/run";
import type { Sandbox } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import { capOutput, runFailure, sandboxFailure, toolFail } from "./shared";

interface CreatePrArgs {
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
}

export class CreatePrTool implements Tool {
  name = "create_pr";
  mutates = true;
  description =
    "Open a GitHub pull request for the current branch with `gh`. Pushes the branch first if it " +
    "has no upstream, and refuses on the default branch. Fields: title (required), body, base, draft.";
  parameters = {
    type: "object",
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      base: { type: "string" },
      draft: { type: "boolean" },
    },
    required: ["title"],
    additionalProperties: false,
  };

  constructor(private readonly sandbox: Sandbox) {}

  serialize(args: unknown): string {
    const a = args as CreatePrArgs;
    const title = (a.title ?? "").split("\n")[0];
    return `gh pr create --title "${title}"${a.draft ? " --draft" : ""}`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as CreatePrArgs;
    if (!a.title || a.title.trim() === "") return toolFail("create_pr needs a title");

    try {
      const branch = await currentBranch(this.sandbox, ctx);
      if (!branch)
        return toolFail("cannot open a PR from a detached HEAD — checkout a branch first");
      const def = await defaultBranch(this.sandbox, ctx);
      if (branch === def) {
        return toolFail(
          `cannot open a PR from the default branch (${def}) — create a feature branch first`,
        );
      }

      // Push when the branch has no upstream.
      const up = await runGit(
        this.sandbox,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        ctx,
      );
      if (up.exitCode !== 0) {
        const pushed = await runGit(this.sandbox, ["push", "-u", "origin", branch], ctx);
        const pf = runFailure("git push", pushed);
        if (pf) return pf;
      }

      const argv = ["pr", "create", "--title", a.title];
      if (a.body !== undefined) argv.push("--body", a.body);
      if (a.base !== undefined) argv.push("--base", a.base);
      if (a.draft) argv.push("--draft");
      const r = await runGh(this.sandbox, argv, ctx);
      const fail = runFailure("gh pr create", r);
      if (fail) return fail;
      return { ok: true, output: capOutput(r.stdout.trim() || "pull request created") };
    } catch (e) {
      return sandboxFailure(e);
    }
  }
}
