import type { RawPackageManager } from "./schema";
import type { PackageManagerConfig } from "./types";

/** Merge global + project package-manager config (project-over-global). Default: enforce Bun in a
 * project that has a Bun lockfile. Set `enforce_bun: false` to allow npx/npm/yarn/pnpm anyway. */
export function resolvePackageManager(
  global?: RawPackageManager,
  project?: RawPackageManager,
): PackageManagerConfig {
  return { enforceBun: project?.enforce_bun ?? global?.enforce_bun ?? true };
}
