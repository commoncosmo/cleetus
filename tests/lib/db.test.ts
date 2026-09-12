import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/lib/db";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cleetus-db-"));
}

test("openDatabase enables WAL and a non-zero busy_timeout", async () => {
  const dir = await tmp();
  try {
    const db = openDatabase(join(dir, "x.db"));
    const jm = db.query("PRAGMA journal_mode;").get() as { journal_mode: string };
    expect(jm.journal_mode.toLowerCase()).toBe("wal");
    const bt = db.query("PRAGMA busy_timeout;").get() as { timeout: number };
    expect(bt.timeout).toBeGreaterThan(0);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WAL lets a concurrent reader and a writer coexist without 'database is locked'", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "shared.db");
    const writer = openDatabase(path, { create: true });
    writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
    writer.run("INSERT INTO t (v) VALUES (?)", ["a"]);
    // Second handle to the same file, open a read transaction (holds a lock under rollback journal).
    const reader = openDatabase(path);
    reader.exec("BEGIN");
    reader.query("SELECT * FROM t").all();
    // Under journal_mode=delete + busy_timeout=0 this write would throw "database is locked".
    expect(() => writer.run("INSERT INTO t (v) VALUES (?)", ["b"])).not.toThrow();
    reader.exec("COMMIT");
    writer.close();
    reader.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a read-only handle skips WAL but still sets busy_timeout", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "ro.db");
    openDatabase(path, { create: true }).close(); // create + set WAL once
    const ro = openDatabase(path, { readonly: true });
    const bt = ro.query("PRAGMA busy_timeout;").get() as { timeout: number };
    expect(bt.timeout).toBeGreaterThan(0);
    ro.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
