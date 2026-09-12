import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCRATCH_PREFIX,
  createScratchDir,
  reapStaleScratchDirs,
  registerScratchCleanup,
} from "../../src/config/scratch-lifecycle";

describe("createScratchDir", () => {
  test("creates a fresh prefixed dir under the base", () => {
    const base = mkdtempSync(join(tmpdir(), "reap-base-"));
    const dir = createScratchDir(base);
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(join(base, SCRATCH_PREFIX))).toBe(true);
  });
});

describe("registerScratchCleanup", () => {
  test("manual cleanup removes the dir and is idempotent", () => {
    const base = mkdtempSync(join(tmpdir(), "reap-base-"));
    const dir = createScratchDir(base);
    const cleanup = registerScratchCleanup(dir);
    cleanup();
    expect(existsSync(dir)).toBe(false);
    expect(() => cleanup()).not.toThrow(); // second call is a no-op
  });
});

describe("reapStaleScratchDirs", () => {
  test("removes stale dirs and spares fresh ones", () => {
    const tmp = mkdtempSync(join(tmpdir(), "reap-tmp-"));
    const stale = join(tmp, `${SCRATCH_PREFIX}old`);
    const fresh = join(tmp, `${SCRATCH_PREFIX}new`);
    const unrelated = join(tmp, "not-scratch");
    mkdirSync(stale);
    mkdirSync(fresh);
    mkdirSync(unrelated);
    const now = 1_000_000_000_000;
    const old = new Date(now - 48 * 3600 * 1000);
    utimesSync(stale, old, old);
    utimesSync(unrelated, old, old);

    const removed = reapStaleScratchDirs({ now, maxAgeMs: 24 * 3600 * 1000, tmp });

    expect(removed).toEqual([`${SCRATCH_PREFIX}old`]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true); // only cleetus-scratch-* is touched
    expect(statSync(fresh).isDirectory()).toBe(true);
  });
});
