import { Database } from "bun:sqlite";
import {
  type PrivateStateOperation,
  createPrivateDatabase,
  preparePrivateState,
  privateFile,
  validatePrivateStateTargets,
} from "../security/private-state";

type DbOptions = ConstructorParameters<typeof Database>[1];

/**
 * Open a sqlite database configured to tolerate concurrent access. Every writable handle in the
 * app should go through here.
 *
 * - `journal_mode = WAL`: readers never block writers (and vice-versa), and multiple writer handles
 *   to the same file within one process coexist, and external readers (forensics, a backup, a
 *   second instance) are common. The default `delete` journal makes any of these collide as
 *   "database is locked".
 * - `busy_timeout`: wait/retry on contention instead of failing instantly with SQLITE_BUSY.
 *
 * A read-only handle can't set the journal mode (it's a write to the file header, which persists
 * once any RW handle sets it), so WAL is skipped there — but the busy_timeout still applies so a
 * reader waits for a writer's brief lock rather than erroring.
 */
export function openDatabase(path: string, opts?: DbOptions): Database {
  const writable = !(opts as { readonly?: boolean } | undefined)?.readonly;
  if (writable && path !== ":memory:") {
    createPrivateDatabase(path);
    if (process.platform !== "win32")
      for (const suffix of ["-wal", "-shm"]) privateFile(path + suffix);
  }
  return openPreparedDatabase(path, opts);
}

/** Only this module opens prepared handles. Batch protection completes before
 * any SQLite write, and handles are transferred directly to their owners. */
export function openDatabaseBatch<T extends Record<string, string>, K extends keyof T = never>(
  paths: T,
  state: readonly PrivateStateOperation[] = [],
  optional?: { key: K; onError: (error: unknown) => void },
): { [P in keyof T]: P extends K ? Database | undefined : Database } {
  const operations = Object.values(paths)
    .filter((path) => path !== ":memory:")
    .map((path) => ({ path, action: "database" as const }));
  preparePrivateState([...state, ...operations]);
  const opened: Database[] = [];
  const result: Partial<Record<keyof T, Database>> = {};
  try {
    for (const key of Object.keys(paths) as (keyof T)[]) {
      const path = paths[key]!;
      // Refuse replaced files, hardlinks, or junctions even after batch protection.
      if (process.platform === "win32" && path !== ":memory:")
        validatePrivateStateTargets([{ path, action: "database" }], true);
      try {
        const db = openPreparedDatabase(
          path,
          path === ":memory:" ? undefined : { readwrite: true },
        );
        opened.push(db);
        result[key] = db;
      } catch (error) {
        // Only SQLite availability is optional. All ACL and path checks above
        // must succeed, including for the recovery mirror.
        if (optional?.key !== key) throw error;
        optional.onError(error);
      }
    }
    return result as { [P in keyof T]: P extends K ? Database | undefined : Database };
  } catch (error) {
    for (const db of opened) db.close();
    throw error;
  }
}

function openPreparedDatabase(path: string, opts?: DbOptions): Database {
  // `new Database(path)` defaults to readwrite+create; `new Database(path, {})` errors ("flags must
  // include READONLY or READWRITE"), so only pass opts when given.
  const db = opts ? new Database(path, opts) : new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    if (!(opts as { readonly?: boolean } | undefined)?.readonly) {
      db.exec("PRAGMA journal_mode = WAL;");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
