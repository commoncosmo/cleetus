import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { type UserPathOptions, userPaths } from "./user-paths";

/** Move whole directories, including SQLite WAL sidecars. Never merge or overwrite data. */
export function migrateWindowsData(
  home: string,
  options: UserPathOptions = {},
  apply = false,
  io: { rename?: typeof renameSync } = {},
) {
  const moveDirectory = io.rename ?? renameSync;
  const paths = userPaths(home, options);
  if ((options.platform ?? process.platform) !== "win32")
    throw new Error("Data migration is for Windows only.");
  if (paths.mode === "portable")
    throw new Error(
      "Portable mode does not import machine data. Disable portable mode to migrate the normal installation.",
    );
  if (existsSync(paths.migrationLock))
    throw new Error(
      `Migration lock exists: ${paths.migrationLock}. Confirm no migration is running before removing a stale lock.`,
    );
  const sourceExists = existsSync(paths.legacyConfig);
  const workspaceExists = existsSync(paths.legacyWorkspace);
  const config =
    sourceExists && existsSync(join(paths.legacyConfig, "config.yaml"))
      ? parse(readFileSync(join(paths.legacyConfig, "config.yaml"), "utf8"))
      : {};
  const moveWorkspace = workspaceExists && !config?.global_workspace_dir;
  const moves = [
    ...(sourceExists ? [{ from: paths.legacyConfig, to: paths.nativeRoot }] : []),
    ...(moveWorkspace
      ? [{ from: paths.legacyWorkspace, to: join(paths.nativeRoot, "workspace") }]
      : []),
  ];
  if (!moves.length) return { moves, applied: false, message: "No legacy data found." };
  if (existsSync(paths.nativeRoot) && readdirSync(paths.nativeRoot).length)
    throw new Error(
      `Destination already contains data: ${paths.nativeRoot}. No data was merged; use --config-dir to select it explicitly.`,
    );
  for (const move of moves)
    if (lstatSync(move.from).isSymbolicLink())
      throw new Error(
        `Migration will not move a linked directory: ${move.from}. Use --config-dir or migrate it manually.`,
      );
  if (sourceExists && moveWorkspace && existsSync(join(paths.legacyConfig, "workspace")))
    throw new Error(
      "Legacy config already contains a workspace directory; migrate manually to avoid a collision.",
    );
  if (!apply)
    return {
      moves,
      applied: false,
      message:
        "Close all Cleetus instances, then rerun with --yes to move these directories. Configured custom workspaces remain unchanged.",
    };
  const completed: typeof moves = [];
  let madeRoot = false;
  mkdirSync(dirname(paths.nativeRoot), { recursive: true });
  const lock = openSync(paths.migrationLock, "wx");
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    if (existsSync(paths.nativeRoot)) rmdirSync(paths.nativeRoot); // empty only
    if (!sourceExists) {
      mkdirSync(paths.nativeRoot);
      madeRoot = true;
    }
    for (const move of moves) {
      moveDirectory(move.from, move.to);
      completed.push(move);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const move of completed.reverse()) {
      try {
        moveDirectory(move.to, move.from);
      } catch {
        rollbackErrors.push(`${move.to} -> ${move.from}`);
      }
    }
    if (madeRoot) {
      try {
        rmdirSync(paths.nativeRoot);
      } catch {}
    }
    throw new Error(
      `Migration failed; close other Cleetus instances and retry. ${String(error)}${rollbackErrors.length ? ` Manual recovery required: ${rollbackErrors.join(", ")}` : "Completed moves were rolled back."}`,
    );
  } finally {
    closeSync(lock);
    unlinkSync(paths.migrationLock);
  }
  return {
    moves,
    applied: true,
    message:
      "Migration complete. Project directories and explicitly configured workspaces were unchanged. Global-workspace trust may need approval again at its new path.",
  };
}
