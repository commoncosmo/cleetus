import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolve the path to the session/event database. A non-empty `sessionDbOpt`
 * (the desktop's `--session-db`) pins the DB to that location independent of the
 * working directory, so a conversation keeps one stable history store across
 * re-homes. Otherwise the DB resolves to the per-cwd default
 * `<projectDir>/.cleetus/sessions.db`.
 */
export function resolveSessionDbPath(projectDir: string, sessionDbOpt?: string): string {
  if (sessionDbOpt && sessionDbOpt.length > 0) return sessionDbOpt;
  return join(projectDir, ".cleetus", "sessions.db");
}

/** Ensure the parent directory of a database path exists before opening it. */
export function ensureParentDir(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
}
