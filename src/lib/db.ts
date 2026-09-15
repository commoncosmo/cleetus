import { Database } from "bun:sqlite";
import { constants, closeSync, openSync } from "node:fs";
import { privateFile } from "../security/private-state";

type DbOptions = ConstructorParameters<typeof Database>[1];

/**
 * Open a sqlite database configured to tolerate concurrent access. Every writable handle in the
 * app should go through here.
 *
 * - `journal_mode = WAL`: readers never block writers (and vice-versa), and multiple writer handles
 *   to the same file within one process coexist — cleetus opens `sessions.db` with two handles
 *   (EventLog + SessionStore/SessionHistoryStore), and external readers (forensics, a backup, a
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
    for (const suffix of ["-wal", "-shm"]) privateFile(path + suffix);
  }
  // `new Database(path)` defaults to readwrite+create; `new Database(path, {})` errors ("flags must
  // include READONLY or READWRITE"), so only pass opts when given.
  const db = opts ? new Database(path, opts) : new Database(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  if (!(opts as { readonly?: boolean } | undefined)?.readonly) {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  return db;
}
