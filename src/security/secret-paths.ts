import { realpathSync } from "node:fs";
import { comparablePath, isPathWithin, pathApi } from "../lib/paths";

/** Single source of truth for secret locations under $HOME. Consumed by BOTH the OS sandbox
 *  policy (src/sandbox/policy.ts — read-denies these for bash subprocesses) and the in-process
 *  read tools (src/tools/read-guard.ts — the sandbox cannot see those). Home-relative. */
export const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker"];
export const SECRET_FILES = [".netrc"];

export interface SecretPathOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

export function secretDirPaths(home: string, options: SecretPathOptions = {}): string[] {
  if (!home) return [];
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const paths = SECRET_DIRS.map((d) => api.join(home, d));
  if (platform === "win32") {
    const roaming = (options.env ?? process.env).APPDATA || api.join(home, "AppData", "Roaming");
    paths.push(api.join(roaming, "gcloud"), api.join(roaming, "gnupg"));
  }
  return paths;
}

export function secretFilePaths(home: string, options: SecretPathOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  return home
    ? [...SECRET_FILES, ...(platform === "win32" ? ["_netrc"] : [])].map((f) =>
        pathApi(platform).join(home, f),
      )
    : [];
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
export function isSecretPath(
  resolvedPath: string,
  home: string,
  options: SecretPathOptions = {},
): boolean {
  if (!home) return false;
  const platform = options.platform ?? process.platform;
  for (const dir of secretDirPaths(home, options)) {
    for (const d of new Set([dir, canonicalOf(dir)])) {
      if (isPathWithin(d, resolvedPath, platform)) return true;
    }
  }
  for (const file of secretFilePaths(home, options)) {
    if (
      [file, canonicalOf(file)].some(
        (f) => comparablePath(resolvedPath, platform) === comparablePath(f, platform),
      )
    )
      return true;
  }
  return false;
}
