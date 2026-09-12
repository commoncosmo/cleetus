import { realpathSync } from "node:fs";
import { join } from "node:path";

import { secretDirPaths, secretFilePaths } from "../security/secret-paths";

/** The resolved sandbox policy that both platform providers consume. */
export interface SandboxPolicy {
  /** Absolute dirs the command may write to (projectDir is always writable, implied separately). */
  writableExtra: string[];
  /** Secret directories rendered unreadable. */
  blockedDirs: string[];
  /** Secret files rendered unreadable. */
  blockedFiles: string[];
  /** Whether the command may use the network. */
  network: boolean;
  /** Project-relative control directories denied writes for this execution. */
  protectedProjectPaths?: string[];
}

/** Package-manager caches under $HOME that must stay writable for installs to work. */
const CACHE_DIRS = [".npm", ".cache", ".bun", ".cargo", ".pnpm-store", ".yarn", ".m2", ".gradle"];

/** Resolve each path to its canonical (symlink-free) form so OS sandboxes that match on the
 *  real vnode path (macOS Seatbelt) grant/deny the intended location. Paths that don't resolve
 *  (not yet created — e.g. a cache dir) keep their literal form. Result is de-duplicated. */
function canonicalize(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    try {
      out.add(realpathSync(p));
    } catch {
      out.add(p); // ENOENT/EACCES → keep literal (HOME-based caches aren't symlinked anyway)
    }
  }
  return [...out];
}

export function buildPolicy(
  env: Record<string, string | undefined>,
  network: boolean,
): SandboxPolicy {
  const home = env.HOME ?? "";
  const writableExtra = ["/tmp"];
  const tmp = env.TMPDIR;
  if (tmp && tmp !== "/tmp" && !writableExtra.includes(tmp)) writableExtra.push(tmp);
  if (home) for (const c of CACHE_DIRS) writableExtra.push(join(home, c));
  const blockedDirs = secretDirPaths(home);
  const blockedFiles = secretFilePaths(home);
  return {
    writableExtra: canonicalize(writableExtra),
    blockedDirs: canonicalize(blockedDirs),
    blockedFiles: canonicalize(blockedFiles),
    network,
    protectedProjectPaths: [],
  };
}
