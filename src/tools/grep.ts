import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Glob } from "bun";
import { splitPatternPrefix } from "../permission/path-guard";
import { refuseIfSecretPath } from "./read-guard";
import type { Tool, ToolContext, ToolResult } from "./types";

interface Args {
  pattern: string;
  path?: string;
  filePattern?: string;
  ignoreCase?: boolean;
  maxMatches?: number;
}

async function hasRg(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bash", "-c", "command -v rg >/dev/null 2>&1"]);
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function rgSearch(a: Args, root: string): Promise<string> {
  const args = ["-n", "--no-heading"];
  if (a.ignoreCase) args.push("-i");
  if (a.filePattern) args.push("--glob", a.filePattern);
  if (a.maxMatches) args.push("--max-count", String(a.maxMatches));
  args.push("-e", a.pattern); // -e binds pattern, immune to leading-dash
  if (a.path) args.push("--", a.path); // -- ends option parsing
  const proc = Bun.spawn(["rg", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

async function jsSearch(a: Args, root: string): Promise<string> {
  const pattern = new RegExp(a.pattern, a.ignoreCase ? "i" : "");
  const filePattern = a.filePattern ?? "**/*";
  const glob = new Glob(filePattern);
  const lines: string[] = [];
  let count = 0;
  const limit = a.maxMatches ?? 500;
  const startDir = a.path ? resolve(root, a.path) : root;
  for await (const file of glob.scan({ cwd: startDir, absolute: true })) {
    try {
      const text = await readFile(file, "utf8");
      const fileLines = text.split("\n");
      for (let i = 0; i < fileLines.length; i++) {
        const line = fileLines[i]!;
        if (pattern.test(line)) {
          lines.push(`${relative(root, file)}:${i + 1}: ${line}`);
          count++;
          if (count >= limit) return lines.join("\n");
        }
      }
    } catch {
      /* skip unreadable */
    }
  }
  return lines.join("\n");
}

export class GrepTool implements Tool {
  name = "grep";
  description = "Search file contents for a regex pattern. Uses ripgrep if available.";
  parameters = {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      file_pattern: { type: "string", description: "Glob filter, e.g. '*.ts'" },
      ignore_case: { type: "boolean", default: false },
      max_matches: { type: "integer", minimum: 1 },
    },
    required: ["pattern"],
  };
  serialize(args: unknown): string {
    const a = args as Args;
    return `grep ${a.pattern}${a.path ? ` in ${a.path}` : ""}`;
  }
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const raw = args as Record<string, unknown>;
    const a: Args = {
      pattern: raw.pattern as string,
      path: raw.path as string | undefined,
      filePattern: (raw.filePattern ?? raw.file_pattern) as string | undefined,
      ignoreCase: Boolean(raw.ignoreCase ?? raw.ignore_case),
      maxMatches: (raw.maxMatches ?? raw.max_matches) as number | undefined,
    };
    const secret = await refuseIfSecretPath(a.path, ctx);
    if (secret) return secret;
    if (a.filePattern) {
      const { prefix, tailHasDotDot } = splitPatternPrefix(a.filePattern);
      if (tailHasDotDot) {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage:
            "grep file_pattern may not contain '..' after a wildcard segment — set 'path' to the directory you want and use a relative file_pattern.",
        };
      }
      const secretPrefix = await refuseIfSecretPath(join(a.path ?? "", prefix), ctx);
      if (secretPrefix) return secretPrefix;
    }
    try {
      const text = (await hasRg())
        ? await rgSearch(a, ctx.projectDir)
        : await jsSearch(a, ctx.projectDir);
      if (text.trim().length === 0) {
        const where = a.path ? ` in ${a.path}` : "";
        return {
          ok: true,
          output: `no matches for pattern '${a.pattern}'${where}. Try a broader pattern, ignore_case, or a different directory.`,
        };
      }
      return { ok: true, output: text };
    } catch (e) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: (e as Error).message };
    }
  }
}
