import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigRoot } from "../../src/config/config-root";
import { resolveLaunchScope } from "../../src/config/launch-scope";
import { migrateWindowsData } from "../../src/config/migrate-data";
import { type UserPathOptions, userPaths } from "../../src/config/user-paths";

let root: string;
let home: string;
let options: UserPathOptions;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cleetus-user-paths-"));
  home = join(root, "home");
  mkdirSync(home);
  options = {
    platform: "win32",
    env: { LOCALAPPDATA: join(root, "Local") },
    executable: join(root, "Programs", "Cleetus", "bin", "cleetus.exe"),
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function legacy() {
  const paths = userPaths(home, options);
  mkdirSync(paths.legacyConfig, { recursive: true });
  writeFileSync(join(paths.legacyConfig, "config.yaml"), "default_model: fixture\n");
  writeFileSync(join(paths.legacyConfig, "events.db-wal"), "wal fixture");
  mkdirSync(paths.legacyWorkspace, { recursive: true });
  writeFileSync(join(paths.legacyWorkspace, "note.txt"), "workspace fixture");
  return paths;
}
test("Windows data defaults are separate from its install, with no filesystem writes", () => {
  const paths = userPaths(home, options);
  expect(paths.configRoot).toBe(join(root, "Local", "Cleetus"));
  expect(paths.workspaceRoot).toBe(join(paths.configRoot, "workspace"));
  expect(paths.installRoot).toBe(join(root, "Programs", "Cleetus"));
  expect(existsSync(paths.configRoot)).toBe(false);
  expect(resolveConfigRoot(undefined, home, root, options)).toBe(paths.configRoot);
});
test("Unix locations retain the existing defaults", () => {
  const paths = userPaths(home, { ...options, platform: "linux" });
  expect(paths.configRoot).toBe(join(home, ".config", "cleetus"));
  expect(paths.workspaceRoot).toBe(join(home, ".cleetus"));
});
test("legacy data stays active until an explicit migration; dry run is read-only", () => {
  const paths = legacy();
  expect(resolveConfigRoot(undefined, home, root, options)).toBe(paths.legacyConfig);
  expect(migrateWindowsData(home, options).applied).toBe(false);
  expect(existsSync(paths.nativeRoot)).toBe(false);
  expect(readFileSync(join(paths.legacyWorkspace, "note.txt"), "utf8")).toBe("workspace fixture");
});
test("migration moves the config tree with WAL files and the default global workspace", () => {
  const paths = legacy();
  expect(migrateWindowsData(home, options, true).applied).toBe(true);
  expect(existsSync(paths.legacyConfig)).toBe(false);
  expect(existsSync(paths.legacyWorkspace)).toBe(false);
  expect(readFileSync(join(paths.nativeRoot, "events.db-wal"), "utf8")).toBe("wal fixture");
  expect(readFileSync(join(paths.nativeRoot, "workspace", "note.txt"), "utf8")).toBe(
    "workspace fixture",
  );
  expect(resolveConfigRoot(undefined, home, root, options)).toBe(paths.nativeRoot);
  expect(migrateWindowsData(home, options, true).applied).toBe(false);
});
test("custom global workspace paths remain configured and untouched", () => {
  const paths = legacy();
  writeFileSync(join(paths.legacyConfig, "config.yaml"), "global_workspace_dir: ~/my-work\n");
  migrateWindowsData(home, options, true);
  expect(existsSync(paths.legacyWorkspace)).toBe(true);
  expect(userPaths(home, options).mode).toBe("native");
  expect(readFileSync(join(paths.nativeRoot, "config.yaml"), "utf8")).toContain("~/my-work");
});
test("two populated roots never merge; explicit config selection still works", () => {
  const paths = legacy();
  mkdirSync(paths.nativeRoot, { recursive: true });
  writeFileSync(join(paths.nativeRoot, "config.yaml"), "default_model: other\n");
  expect(() => resolveConfigRoot(undefined, home, root, options)).toThrow("Both legacy and native");
  expect(() => migrateWindowsData(home, options, true)).toThrow("already contains data");
  expect(resolveConfigRoot(paths.nativeRoot, home, root, options)).toBe(paths.nativeRoot);
  expect(readFileSync(join(paths.legacyConfig, "config.yaml"), "utf8")).toContain("fixture");
});
test("a failed workspace move restores the entire legacy config", () => {
  const paths = legacy();
  let count = 0;
  expect(() =>
    migrateWindowsData(home, options, true, {
      rename: (from, to) => {
        if (++count === 2) throw new Error("fixture lock");
        renameSync(from, to);
      },
    }),
  ).toThrow("rolled back");
  expect(existsSync(paths.nativeRoot)).toBe(false);
  expect(readFileSync(join(paths.legacyConfig, "events.db-wal"), "utf8")).toBe("wal fixture");
  expect(existsSync(paths.legacyWorkspace)).toBe(true);
});
test("portable data follows the install prefix and never imports machine data", () => {
  const paths = legacy();
  mkdirSync(paths.installRoot, { recursive: true });
  writeFileSync(join(paths.installRoot, "cleetus.portable"), "");
  const portable = userPaths(home, options);
  expect(portable.mode).toBe("portable");
  expect(portable.dataRoot).toBe(join(paths.installRoot, "data"));
  expect(resolveConfigRoot(join(root, "override"), home, root, options)).toBe(
    join(root, "override"),
  );
  expect(() => migrateWindowsData(home, options, true)).toThrow("Portable mode");
  expect(userPaths(home, { ...options, env: { ...options.env, CLEETUS_PORTABLE: "0" } }).mode).toBe(
    "legacy",
  );
  const launch = resolveLaunchScope({
    global: true,
    scratch: false,
    home,
    cwd: root,
    userPathOptions: options,
  });
  expect(launch.dir).toBe(join(paths.installRoot, "data", "workspace"));
});
test("standalone portable ZIP uses data beside its executable; env mode can enable it", () => {
  const portable = userPaths(home, {
    ...options,
    executable: join(root, "zip", "cleetus.exe"),
    env: { CLEETUS_PORTABLE: "1" },
  });
  expect(portable.dataRoot).toBe(join(root, "zip", "data"));
});

test("a migration lock blocks new default sessions and competing migrations", () => {
  const paths = legacy();
  mkdirSync(join(root, "Local"), { recursive: true });
  writeFileSync(paths.migrationLock, JSON.stringify({ pid: process.pid }));
  expect(() => resolveConfigRoot(undefined, home, root, options)).toThrow(
    "migration is in progress",
  );
  expect(() => migrateWindowsData(home, options, true)).toThrow("Migration lock exists");
  expect(readFileSync(join(paths.legacyConfig, "config.yaml"), "utf8")).toContain("fixture");
});

test("an adjacent marker also works when a manually extracted ZIP directory is named bin", () => {
  const zip = join(root, "standalone", "bin");
  mkdirSync(zip, { recursive: true });
  writeFileSync(join(zip, "cleetus.portable"), "");
  expect(userPaths(home, { ...options, executable: join(zip, "cleetus.exe") }).dataRoot).toBe(
    join(zip, "data"),
  );
});
