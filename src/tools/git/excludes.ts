import { resolve } from "node:path";
import { runGit } from "../../git/run";
import type { GitRunContext } from "../../git/run";
import type { Sandbox } from "../../sandbox/types";

/** Dirs/files that must never land in a user's repo when a project was scaffolded without a
 *  .gitignore. Same spirit as the checkpoint shadow repo's exclude set
 *  (src/checkpoint/shadow-repo.ts), trimmed to the entries the issue calls out. */
export const SCAFFOLD_EXCLUDES = ["node_modules/", "dist/", "build/", ".cleetus/", "*.log", ".env"];

/**
 * Pure: given the current `.git/info/exclude` content, return the new content with only the
 * entries not already present appended under a marker comment, plus the list that was added.
 * Returns null when every entry is already present. Comparison is line-trimmed; existing content
 * is preserved verbatim and a separator newline is inserted only when it lacks a trailing one.
 */
export function mergeExcludes(
  existing: string,
  entries: string[],
): { content: string; added: string[] } | null {
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const added = entries.filter((e) => !have.has(e));
  if (added.length === 0) return null;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  return {
    content: `${existing}${prefix}# cleetus: project has no .gitignore for these\n${added.join("\n")}\n`,
    added,
  };
}

/**
 * Safety net for scaffolded projects: before staging, seed the repo's local `.git/info/exclude`
 * (never committed) with SCAFFOLD_EXCLUDES so a `git add -A` can't commit node_modules/.cleetus/
 * etc. No-op when `node_modules` is already ignored (a .gitignore or existing rules govern the
 * tree) or when not in a git repo. Returns a one-line note when it seeded, else "".
 */
export async function ensureScaffoldExcludes(
  sandbox: Sandbox,
  ctx: GitRunContext,
): Promise<string> {
  try {
    // exit 1 = not ignored → seed; 0 = already ignored, 128/null/other = not a repo / error → no-op.
    // Probe the directory form (trailing slash) so a conventional `node_modules/` rule in a
    // .gitignore is detected even before the dir exists on disk (bare `node_modules` returns
    // "not ignored" in that case, causing a false-positive seed + misleading note).
    const probe = await runGit(sandbox, ["check-ignore", "-q", "node_modules/"], ctx);
    if (probe.exitCode !== 1) return "";

    const pathRes = await runGit(sandbox, ["rev-parse", "--git-path", "info/exclude"], ctx);
    if (pathRes.exitCode !== 0) return "";
    const rel = pathRes.stdout.trim();
    if (!rel) return "";
    const excludePath = resolve(ctx.projectDir, rel);

    const file = Bun.file(excludePath);
    const existing = (await file.exists()) ? await file.text() : "";
    const merged = mergeExcludes(existing, SCAFFOLD_EXCLUDES);
    if (!merged) return "";
    await Bun.write(excludePath, merged.content);
    return `Note: seeded .git/info/exclude with ${merged.added.join(", ")} — these scaffold dirs weren't git-ignored, so they won't be committed. Consider adding them to a .gitignore.`;
  } catch {
    return "";
  }
}
