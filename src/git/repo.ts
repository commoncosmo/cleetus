import type { Sandbox } from "../sandbox/types";
import { parseDefaultBranch } from "./parse";
import { type GitRunContext, runGit } from "./run";

/** True when projectDir is inside a git work tree. Never throws (sandbox/git failures → false). */
export async function isGitRepo(sandbox: Sandbox, ctx: GitRunContext): Promise<boolean> {
  try {
    const r = await runGit(sandbox, ["rev-parse", "--is-inside-work-tree"], ctx);
    return r.exitCode === 0 && r.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** The checked-out branch name, or null on a detached HEAD / failure. */
export async function currentBranch(sandbox: Sandbox, ctx: GitRunContext): Promise<string | null> {
  const r = await runGit(sandbox, ["rev-parse", "--abbrev-ref", "HEAD"], ctx);
  if (r.exitCode !== 0) return null;
  const b = r.stdout.trim();
  return b && b !== "HEAD" ? b : null;
}

/**
 * The repo's default branch. Prefers the local `origin/HEAD` symbolic ref (no network);
 * falls back to whichever of `main`/`master` exists locally, else `main`.
 */
export async function defaultBranch(sandbox: Sandbox, ctx: GitRunContext): Promise<string> {
  const sym = await runGit(sandbox, ["symbolic-ref", "refs/remotes/origin/HEAD"], ctx);
  if (sym.exitCode === 0) {
    const name = parseDefaultBranch(sym.stdout);
    if (name) return name;
  }
  for (const cand of ["main", "master"]) {
    const v = await runGit(sandbox, ["show-ref", "--verify", "--quiet", `refs/heads/${cand}`], ctx);
    if (v.exitCode === 0) return cand;
  }
  return "main";
}
