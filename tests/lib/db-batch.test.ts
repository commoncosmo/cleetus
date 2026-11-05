import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../src/events/log";
import { openDatabaseBatch } from "../../src/lib/db";
import { preparePrivateState } from "../../src/security/private-state";

test("a failed optional recovery database does not discard the protected primary log", () => {
  const root = mkdtempSync(join(tmpdir(), "cleetus-db-optional-"));
  const path = join(root, "sessions.db");
  const mirror = join(root, "mirror.db");
  writeFileSync(mirror, "invalid sqlite fixture");
  const failures: unknown[] = [];
  try {
    const dbs = openDatabaseBatch({ sessions: path, mirror }, [], {
      key: "mirror",
      onError: (e) => failures.push(e),
    });
    expect(dbs.mirror).toBeUndefined();
    expect(failures.length).toBe(1);
    const log = new EventLog(path, {
      database: dbs.sessions,
      mirrorPath: mirror,
      mirrorDatabase: null,
    });
    try {
      log.append({ sessionId: "s", type: "user_input", payload: { text: "private" } });
      expect(log.query("s").length).toBe(1);
    } finally {
      log.close();
      dbs.sessions.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "database batches retain POSIX protection for existing databases and sidecars",
  () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-db-batch-"));
    const path = join(root, "sessions.db");
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        writeFileSync(path + suffix, "");
        chmodSync(path + suffix, 0o666);
      }
      preparePrivateState([{ path, action: "database" }]);
      for (const suffix of ["", "-wal", "-shm"])
        expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
      const dbs = openDatabaseBatch({ sessions: path });
      try {
        dbs.sessions.exec("CREATE TABLE sample(value TEXT);INSERT INTO sample VALUES ('private')");
        expect(dbs.sessions.query("SELECT value FROM sample").get()).toEqual({ value: "private" });
      } finally {
        dbs.sessions.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
