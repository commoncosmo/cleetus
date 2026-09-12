import { runGit } from "../../git/run";
import type { Sandbox } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import { capOutput, runFailure, sandboxFailure } from "./shared";

interface DiffArgs {
  staged?: boolean;
  paths?: string[];
}

export class GitDiffTool implements Tool {
  name = "git_diff";
  description =
    "Show a unified diff of changes. Defaults to unstaged changes; set staged:true for the index. " +
    "Optionally limit to `paths`.";
  parameters = {
    type: "object",
    properties: {
      staged: { type: "boolean" },
      paths: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  };

  constructor(private readonly sandbox: Sandbox) {}

  serialize(args: unknown): string {
    const a = args as DiffArgs;
    const paths = a.paths?.length ? ` -- ${a.paths.join(" ")}` : "";
    return `git diff${a.staged ? " --staged" : ""}${paths}`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as DiffArgs;
    const argv = ["diff"];
    if (a.staged) argv.push("--staged");
    if (a.paths?.length) argv.push("--", ...a.paths);
    let r: Awaited<ReturnType<typeof runGit>>;
    try {
      r = await runGit(this.sandbox, argv, ctx);
    } catch (e) {
      return sandboxFailure(e);
    }
    const fail = runFailure("git diff", r);
    if (fail) return fail;
    const out = r.stdout.trim();
    return { ok: true, output: out ? capOutput(out) : "no changes" };
  }
}
