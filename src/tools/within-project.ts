import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { protectedControlPath } from "../agent/scope-guard";
import { pathEscapesProject, realpathWithMissingParents } from "../permission/path-guard";
import { refuseIfSecretPath } from "./read-guard";
import type { ToolContext, ToolResult } from "./types";

/** Returns a refusal ToolResult if `rawPath` escapes the project and the session has not
 *  granted out-of-project writes; otherwise null (caller proceeds with the write). */
export async function refuseIfOutsideProject(
  rawPath: string,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  // A missing/non-string path is not ours to flag — let the tool's own arg handling
  // produce its error rather than throwing a cryptic TypeError from path resolution.
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  const secret = await refuseIfSecretPath(rawPath, ctx);
  if (secret) return secret;
  const root = await realpath(ctx.projectDir);
  const target = resolve(ctx.projectDir, rawPath);
  const canonical = await realpathWithMissingParents(target);
  if (
    protectedControlPath(relative(resolve(ctx.projectDir), target)) ||
    protectedControlPath(relative(root, canonical))
  ) {
    return {
      ok: false,
      errorCode: "TOOL_FAILED",
      errorMessage: "refusing to modify protected .git/.cleetus control metadata",
    };
  }
  // Refuse symlink components below the project root, including dangling leaf links.
  // Callers must use the actual file path; a link must never hide write authority.
  let current = resolve(root, relative(resolve(ctx.projectDir), target));
  while (current !== root && current.startsWith(root + sep)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: "refusing a symlink write target; use its real path",
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
  if (ctx.allowOutsideProject) return null;
  if (!(await pathEscapesProject(rawPath, ctx.projectDir))) return null;
  return {
    ok: false,
    errorCode: "OUT_OF_TREE",
    errorMessage: `refusing to write outside the project root '${ctx.projectDir}': '${rawPath}'. Use a path relative to the project root.`,
  };
}
