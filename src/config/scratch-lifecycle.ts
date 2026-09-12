import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCRATCH_PREFIX = "cleetus-scratch-";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fresh throwaway working dir under `base` (default os.tmpdir()). */
export function createScratchDir(base: string = tmpdir()): string {
  return mkdtempSync(join(base, SCRATCH_PREFIX));
}

/** Remove `dir` once; safe to call more than once and never throws (cleanup must not crash exit). */
function removeOnce(dir: string, done: { value: boolean }): void {
  if (done.value) return;
  done.value = true;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort: a scratch dir we cannot remove is not worth crashing over.
  }
}

/** Register a synchronous `exit` handler that deletes `dir`, and return a manual, idempotent
 *  cleanup. We deliberately do NOT install SIGINT/SIGTERM handlers: the interactive TUI (Ink)
 *  already owns SIGINT for graceful unmount, and adding our own would race its teardown. Normal
 *  exits (including Ink's own `process.exit` after Ctrl+C) fire `exit` and are cleaned here; a hard
 *  signal-kill that skips `exit` leaks the dir, which the startup reaper reclaims next launch. */
export function registerScratchCleanup(dir: string): () => void {
  const done = { value: false };
  const cleanup = () => removeOnce(dir, done);
  process.once("exit", cleanup);
  return cleanup;
}

/** Sweep `cleetus-scratch-*` dirs under `tmp` older than `maxAgeMs` (by mtime). Best-effort;
 *  returns the basenames removed.
 *
 *  Liveness caveat: staleness is judged by the top-level scratch dir's own mtime, which is NOT
 *  bumped by writes into nested subdirectories/files (only direct entries of `tmp` are stat'd).
 *  A long-running scratch session that only ever writes inside subdirectories can therefore look
 *  idle past `maxAgeMs` and have its dir reclaimed out from under it by another launch's reaper,
 *  even though the session is still active. */
export function reapStaleScratchDirs(opts: {
  now: number;
  maxAgeMs?: number;
  tmp?: string;
}): string[] {
  const tmp = opts.tmp ?? tmpdir();
  const maxAgeMs = opts.maxAgeMs ?? DAY_MS;
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(tmp);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const full = join(tmp, name);
    try {
      if (opts.now - statSync(full).mtimeMs < maxAgeMs) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // skip anything we can't stat/remove
    }
  }
  return removed;
}
