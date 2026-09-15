import {
  constants,
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Only use for application-owned directories, never a project/source root. */
export function privateDirectory(path: string): void {
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
  chmodSync(path, 0o600);
}

export function writePrivateFile(path: string, content: string | Uint8Array): void {
  // A caller may select a file in an existing shared/source directory. Never chmod that
  // parent implicitly; privateDirectory is a separate operation for known app-owned roots.
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
