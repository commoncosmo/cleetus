import { pathEscapesProject } from "../permission/path-guard";
import type { ToolContext, ToolResult } from "./types";

/** Returns a refusal ToolResult if `rawPath` escapes the project and the session has not
 *  granted out-of-project writes; otherwise null (caller proceeds with the write). */
export async function refuseIfOutsideProject(
  rawPath: string,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (ctx.allowOutsideProject) return null;
  // A missing/non-string path is not ours to flag — let the tool's own arg handling
  // produce its error rather than throwing a cryptic TypeError from path resolution.
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  if (!(await pathEscapesProject(rawPath, ctx.projectDir))) return null;
  return {
    ok: false,
    errorCode: "OUT_OF_TREE",
    errorMessage: `refusing to write outside the project root '${ctx.projectDir}': '${rawPath}'. Use a path relative to the project root.`,
  };
}
