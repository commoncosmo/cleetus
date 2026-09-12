import { join, resolve } from "node:path";
import { Glob } from "bun";
import { splitPatternPrefix } from "../permission/path-guard";
import { refuseIfSecretPath } from "./read-guard";
import type { Tool, ToolContext, ToolResult } from "./types";

interface Args {
  pattern: string;
  cwd?: string;
  limit?: number;
}

export class GlobTool implements Tool {
  name = "glob";
  description = "Find files matching a glob pattern (e.g. `src/**/*.ts`).";
  parameters = {
    type: "object",
    properties: {
      pattern: { type: "string" },
      cwd: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["pattern"],
  };
  serialize(args: unknown): string {
    return `glob ${(args as Args).pattern}`;
  }
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as Args;
    const secret = await refuseIfSecretPath(a.cwd, ctx);
    if (secret) return secret;
    const { prefix, tailHasDotDot } = splitPatternPrefix(a.pattern);
    if (tailHasDotDot) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage:
          "glob patterns may not contain '..' after a wildcard segment — set 'cwd' to the directory you want and use a relative pattern.",
      };
    }
    const secretPrefix = await refuseIfSecretPath(a.cwd ? join(a.cwd, prefix) : prefix, ctx);
    if (secretPrefix) return secretPrefix;
    const limit = a.limit ?? 1000;
    const base = a.cwd ? resolve(ctx.projectDir, a.cwd) : ctx.projectDir;
    try {
      const glob = new Glob(a.pattern);
      const out: string[] = [];
      for await (const path of glob.scan({ cwd: base, absolute: true })) {
        out.push(path);
        if (out.length >= limit) break;
      }
      if (out.length === 0) {
        const where = a.cwd ? ` in ${a.cwd}` : "";
        return {
          ok: true,
          output: `no files match '${a.pattern}'${where}. Broaden the pattern or set a different cwd.`,
        };
      }
      return { ok: true, output: out.join("\n") };
    } catch (e) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: (e as Error).message };
    }
  }
}
