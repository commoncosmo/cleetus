import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/agent/session";
import { ensureParentDir, resolveSessionDbPath } from "../../src/agent/session-db-path";
import { openDatabase } from "../../src/lib/db";

test("resolveSessionDbPath defaults to <projectDir>/.cleetus/sessions.db", () => {
  expect(resolveSessionDbPath("/proj")).toBe(join("/proj", ".cleetus", "sessions.db"));
});

test("resolveSessionDbPath pins to the explicit path independent of cwd", () => {
  const a = resolveSessionDbPath("/projA", "/pinned/s.db");
  const b = resolveSessionDbPath("/projB", "/pinned/s.db");
  expect(a).toBe("/pinned/s.db");
  expect(a).toBe(b);
});

test("resolveSessionDbPath falls back to the default on an empty string", () => {
  expect(resolveSessionDbPath("/proj", "")).toBe(join("/proj", ".cleetus", "sessions.db"));
});

test("ensureParentDir creates a missing parent directory", () => {
  const root = mkdtempSync(join(tmpdir(), "cleetus-db-"));
  const dbPath = join(root, "nested", "deeper", "sessions.db");
  expect(existsSync(join(root, "nested"))).toBe(false);
  ensureParentDir(dbPath);
  expect(existsSync(join(root, "nested", "deeper"))).toBe(true);
});

test("a session created at a pinned path resumes after reopening that path", () => {
  const root = mkdtempSync(join(tmpdir(), "cleetus-db-"));
  const dbPath = join(root, "sessions.db");
  ensureParentDir(dbPath);
  const db1 = openDatabase(dbPath);
  new SessionStore(db1).create({ id: "sess-x", provider: "p", model: "m" });
  db1.close();
  // Re-open the SAME pinned path — what a re-home into a new cwd does — and resume.
  const db2 = openDatabase(dbPath);
  expect(new SessionStore(db2).get("sess-x")?.id).toBe("sess-x");
  db2.close();
});
