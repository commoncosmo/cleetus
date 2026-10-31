import {
  constants,
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { windowsPrivateState } from "./windows-private-state";

function validateTree(path: string, excludeChildren: readonly string[] = [], descend = true): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) {
    throw new Error(`private state contains a linked or unsupported entry: ${path}`);
  }
  if (info.isDirectory() && descend)
    for (const name of readdirSync(path))
      validateTree(
        join(path, name),
        [],
        !excludeChildren.some((excluded) => excluded.toLowerCase() === name.toLowerCase()),
      );
}

function validateWindowsTarget(path: string, excludeChildren: readonly string[] = []): void {
  // A regular final file can still be reached through a junction in a parent.
  // Refuse those aliases rather than changing another tree's permissions.
  let parent = dirname(resolve(path));
  while (true) {
    try {
      if (lstatSync(parent).isSymbolicLink())
        throw new Error(`private state parent is linked: ${parent}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  try {
    validateTree(path, excludeChildren);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Only use for application-owned directories, never a project/source root. */
export function privateDirectory(
  path: string,
  options: { excludeChildren?: readonly string[] } = {},
): void {
  if (process.platform === "win32") {
    const excluded = options.excludeChildren ?? [];
    if (excluded.some((name) => !name || name === "." || name === ".." || /[\\/]/.test(name)))
      throw new Error("Private directory exclusions must be direct child names");
    validateWindowsTarget(path, excluded);
    windowsPrivateState(path, "directory", undefined, excluded);
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`private state directory is not a real directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

export function privateFile(path: string): void {
  // existsSync follows links and reports false for dangling links. Inspect the directory
  // entry itself so SQLite cannot follow a pre-planted dangling link when creating a DB.
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`private state file is not a regular unlinked file: ${path}`);
  }
  if (process.platform === "win32") {
    validateWindowsTarget(path);
    windowsPrivateState(path, "file");
  } else chmodSync(path, 0o600);
}

/** Create an empty private file without a public inherited-ACL window on Windows. */
export function createPrivateFile(path: string): void {
  if (process.platform === "win32") {
    validateWindowsTarget(path);
    windowsPrivateState(path, "create");
    return;
  }
  try {
    closeSync(
      openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privateFile(path);
}

/** SQLite can create sidecars before the caller can tighten their ACLs. Precreate
 * all three privately, without locking an already-open database's data handle. */
export function createPrivateDatabase(path: string): void {
  if (process.platform !== "win32") {
    createPrivateFile(path);
    return;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    validateWindowsTarget(path + suffix);
  }
  windowsPrivateState(path, "database");
}

export function writePrivateFile(path: string, content: string | Uint8Array): void {
  // A caller may select a file in an existing shared/source directory. Never chmod that
  // parent implicitly; privateDirectory is a separate operation for known app-owned roots.
  if (process.platform === "win32") {
    validateWindowsTarget(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    windowsPrivateState(path, "write", content);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  privateFile(path);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
