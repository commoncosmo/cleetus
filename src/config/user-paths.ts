import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface UserPathOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  executable?: string;
  exists?: (path: string) => boolean;
  populated?: (path: string) => boolean;
}

export function userPaths(home = homedir(), options: UserPathOptions = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const executableDir = dirname(options.executable ?? process.execPath);
  const exists = options.exists ?? existsSync;
  const populated =
    options.populated ?? ((path: string) => exists(path) && readdirSync(path).length > 0);
  const parent = dirname(executableDir);
  const installRoot = exists(join(executableDir, "cleetus.portable"))
    ? executableDir
    : basename(executableDir).toLowerCase() === "bin"
      ? parent
      : executableDir;
  const portable =
    platform === "win32" &&
    (env.CLEETUS_PORTABLE === "1" ||
      (env.CLEETUS_PORTABLE !== "0" && exists(join(installRoot, "cleetus.portable"))));
  const legacyConfig = join(home, ".config", "cleetus");
  const legacyWorkspace = join(home, ".cleetus");
  const nativeRoot = join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Cleetus");
  const nativePresent = populated(nativeRoot);
  const legacyConfigPresent = populated(legacyConfig);
  const legacy =
    !portable &&
    platform === "win32" &&
    (legacyConfigPresent || (!nativePresent && populated(legacyWorkspace)));
  const conflict = !portable && platform === "win32" && legacyConfigPresent && nativePresent;
  const dataRoot = portable
    ? join(installRoot, "data")
    : platform === "win32"
      ? legacy
        ? legacyConfig
        : nativeRoot
      : legacyConfig;
  return {
    installRoot,
    dataRoot,
    configRoot: dataRoot,
    nativeRoot,
    migrationLock: `${nativeRoot}.migration.lock`,
    legacyConfig,
    legacyWorkspace,
    workspaceRoot:
      portable || (platform === "win32" && !legacy) ? join(dataRoot, "workspace") : legacyWorkspace,
    cacheRoot: join(dataRoot, "cache"),
    mode: portable
      ? ("portable" as const)
      : legacy
        ? ("legacy" as const)
        : platform === "win32"
          ? ("native" as const)
          : ("unix" as const),
    conflict,
  };
}
