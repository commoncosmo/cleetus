import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type UserPathOptions, userPaths } from "./user-paths";

/** Resolve the cleetus config root. An explicit `--config-dir` wins (absolutized against `cwd`
 *  when relative); otherwise the default `~/.config/cleetus`. Pure — `home`/`cwd` are injected so
 *  the whole thing is testable. */
export function resolveConfigRoot(
  configDir: string | undefined,
  home: string,
  cwd: string,
  options: UserPathOptions = {},
): string {
  if (configDir?.trim()) {
    return isAbsolute(configDir) ? configDir : resolve(cwd, configDir);
  }
  const paths = userPaths(home, options);
  if (
    (options.platform ?? process.platform) === "win32" &&
    paths.mode !== "portable" &&
    (options.exists ?? existsSync)(paths.migrationLock)
  ) {
    throw new Error(
      `Cleetus data migration is in progress or left a stale lock: ${paths.migrationLock}. Close other instances; inspect the migration before removing a stale lock.`,
    );
  }
  if (paths.conflict)
    throw new Error(
      "Both legacy and native Cleetus data contain files. Choose --config-dir explicitly; no data was merged. Run cleetus migrate-data to inspect paths.",
    );
  return paths.configRoot;
}
