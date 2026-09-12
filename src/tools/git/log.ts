import { runGit } from "../../git/run";
import type { Sandbox } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import { runFailure, sandboxFailure } from "./shared";

interface LogArgs {
  limit?: number;
  paths?: string[];
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(n?: number): number {
  return Math.min(Math.max(Math.floor(n ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
}

export class GitLogTool implements Tool {
  name = "git_log";
  description = "Show recent commits as `<short-sha> <subject>` lines (default 20, max 100).";
  parameters = {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1 },
      paths: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  };

  constructor(private readonly sandbox: Sandbox) {}

  serialize(args: unknown): string {
    return `git log --oneline -n ${clampLimit((args as LogArgs).limit)}`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as LogArgs;
    const argv = ["log", "--oneline", "-n", String(clampLimit(a.limit))];
    if (a.paths?.length) argv.push("--", ...a.paths);
    let r: Awaited<ReturnType<typeof runGit>>;
    try {
      r = await runGit(this.sandbox, argv, ctx);
    } catch (e) {
      return sandboxFailure(e);
    }
    const fail = runFailure("git log", r);
    if (fail) return fail;
    return { ok: true, output: r.stdout.trim() || "no commits" };
  }
}
