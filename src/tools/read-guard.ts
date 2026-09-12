import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { realpathWithMissingParents } from "../permission/path-guard";
import { SECRET_DIRS, SECRET_FILES, isSecretPath } from "../security/secret-paths";
import type { ToolContext, ToolResult } from "./types";

const SECRET_LOCATIONS_LIST = [...SECRET_DIRS, ...SECRET_FILES].map((p) => `~/${p}`).join(", ");

/**
 * Refusal guard for the in-process read tools (read_file, glob, grep). The OS sandbox
 * read-denies secret dirs only for bash SUBPROCESSES; these tools run inside the cleetus
 * process, so the same denylist is enforced here. Resolves symlinks (an in-project link to
 * ~/.ssh/id_rsa is caught) and is deliberately NOT bypassed by ctx.allowOutsideProject —
 * there is no legitimate agent use for reading secret material.
 * Returns null when the path is fine (caller proceeds).
 */
export async function refuseIfSecretPath(
  rawPath: string | undefined,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  const target = isAbsolute(rawPath) ? rawPath : resolve(ctx.projectDir, rawPath);
  const real = await realpathWithMissingParents(target);
  if (!isSecretPath(real, ctx.homeDir ?? homedir())) return null;
  return {
    ok: false,
    errorCode: "SECRET_PATH",
    errorMessage: `refusing to read '${rawPath}': it resolves into a protected secrets location (${SECRET_LOCATIONS_LIST}). This is not overridable. Do not retry via bash or other tools.`,
  };
}
