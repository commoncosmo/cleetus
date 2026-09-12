import { realpathSync } from "node:fs";
import { join, sep } from "node:path";

/** Single source of truth for secret locations under $HOME. Consumed by BOTH the OS sandbox
 *  policy (src/sandbox/policy.ts — read-denies these for bash subprocesses) and the in-process
 *  read tools (src/tools/read-guard.ts — the sandbox cannot see those). Home-relative. */
export const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker"];
export const SECRET_FILES = [".netrc"];

export function secretDirPaths(home: string): string[] {
  return home ? SECRET_DIRS.map((d) => join(home, d)) : [];
}

export function secretFilePaths(home: string): string[] {
  return home ? SECRET_FILES.map((f) => join(home, f)) : [];
}

// Secret dir/file locations are session-constant (derived from $HOME), so their canonical form
// never changes mid-run — memoize to avoid a realpathSync syscall on every read/write check.
const canonicalCache = new Map<string, string>();

/** Best-effort canonical form; ENOENT/EACCES keep the literal (matches policy.ts behavior). */
function canonicalOf(p: string): string {
  const cached = canonicalCache.get(p);
  if (cached !== undefined) return cached;
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    real = p;
  }
  canonicalCache.set(p, real);
  return real;
}

/** True when `resolvedPath` (already symlink-resolved by the caller) is a secret file, a secret
 *  dir, or inside one. Secret locations are checked in both literal and canonical form so a
 *  symlinked $HOME cannot dodge the match. */
export function isSecretPath(resolvedPath: string, home: string): boolean {
  if (!home) return false;
  for (const dir of secretDirPaths(home)) {
    for (const d of new Set([dir, canonicalOf(dir)])) {
      if (resolvedPath === d || resolvedPath.startsWith(d + sep)) return true;
    }
  }
  for (const file of secretFilePaths(home)) {
    if (resolvedPath === file || resolvedPath === canonicalOf(file)) return true;
  }
  return false;
}
