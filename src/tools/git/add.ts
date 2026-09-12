import { shellJoin } from "../../git/quote";
import { runGit } from "../../git/run";
import type { Sandbox } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import { ensureScaffoldExcludes } from "./excludes";
import { runFailure, sandboxFailure, toolFail } from "./shared";

interface AddArgs {
  paths?: string[];
  all?: boolean;
}

export class GitAddTool implements Tool {
  name = "git_add";
  mutates = true;
  description = "Stage changes. Provide `paths` (a list) or `all:true` to stage everything.";
  parameters = {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" } },
      all: { type: "boolean" },
    },
    additionalProperties: false,
  };

  constructor(private readonly sandbox: Sandbox) {}

  serialize(args: unknown): string {
    const a = args as AddArgs;
    return a.all ? "git add -A" : `git add -- ${shellJoin(a.paths ?? [])}`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as AddArgs;
    if (!a.all && (!a.paths || a.paths.length === 0)) {
      return toolFail("git_add needs `paths` (a non-empty list) or `all:true`");
    }
    const note = await ensureScaffoldExcludes(this.sandbox, ctx);
    const argv = a.all ? ["add", "-A"] : ["add", "--", ...(a.paths as string[])];
    let r: Awaited<ReturnType<typeof runGit>>;
    try {
      r = await runGit(this.sandbox, argv, ctx);
    } catch (e) {
      return sandboxFailure(e);
    }
    const fail = runFailure("git add", r);
    if (fail) return fail;
    const base = a.all ? "staged all changes" : `staged ${a.paths!.length} path(s)`;
    return { ok: true, output: note ? `${note}\n${base}` : base };
  }
}
