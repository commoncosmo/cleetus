import { runGit } from "../../git/run";
import type { Sandbox } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import { ensureScaffoldExcludes } from "./excludes";
import { capOutput, runFailure, sandboxFailure, toolFail } from "./shared";

interface CommitArgs {
  message?: string;
  stage?: "all" | string[];
}

export class GitCommitTool implements Tool {
  name = "git_commit";
  mutates = true;
  description =
    'Commit staged changes with a message. Optional `stage`: "all" to stage every change first, ' +
    "or a list of paths to stage first. Omit `stage` to commit only what is already staged.";
  parameters = {
    type: "object",
    properties: {
      message: { type: "string" },
      stage: {
        oneOf: [
          { type: "string", enum: ["all"] },
          { type: "array", items: { type: "string" } },
        ],
      },
    },
    required: ["message"],
    additionalProperties: false,
  };

  constructor(private readonly sandbox: Sandbox) {}

  serialize(args: unknown): string {
    const first = ((args as CommitArgs).message ?? "").split("\n")[0];
    return `git commit -m "${first}"`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as CommitArgs;
    if (!a.message || a.message.trim() === "") {
      return toolFail("git_commit needs a non-empty message");
    }

    try {
      let note = "";
      // Stage first if requested.
      if (a.stage === "all" || Array.isArray(a.stage)) {
        note = await ensureScaffoldExcludes(this.sandbox, ctx);
        const addArgv = a.stage === "all" ? ["add", "-A"] : ["add", "--", ...a.stage];
        const sr = await runGit(this.sandbox, addArgv, ctx);
        const sf = runFailure("git add", sr);
        if (sf) return sf;
      } else {
        // stage omitted → guard against an empty commit.
        const staged = await runGit(this.sandbox, ["diff", "--cached", "--quiet"], ctx);
        if (staged.exitCode === 0) {
          return toolFail("nothing staged to commit — pass stage:'all' or a path list");
        }
      }

      const r = await runGit(this.sandbox, ["commit", "-m", a.message], ctx);
      const fail = runFailure("git commit", r);
      if (fail) return fail;
      const base = capOutput(r.stdout.trim() || "committed");
      return { ok: true, output: note ? `${note}\n${base}` : base };
    } catch (e) {
      return sandboxFailure(e);
    }
  }
}
