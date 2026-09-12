import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReferencedSha256,
  findOrphans,
  gcAttachments,
  maybeGcOnStartup,
} from "../../src/agent/attachment-gc";
import { SessionHistoryStore } from "../../src/agent/session-history";

const SHA = (n: number) => `${n}`.padStart(64, "0"); // 64-hex-ish stable ids
const HOUR = 60 * 60 * 1000;

let dir: string;
let storeDir: string;
let db: Database;
let history: SessionHistoryStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-gc-"));
  storeDir = join(dir, ".cleetus", "attachments");
  mkdirSync(storeDir, { recursive: true });
  db = new Database(join(dir, "sessions.db"));
  history = new SessionHistoryStore(db); // ensures the session_history table exists
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Write an attachment file and stamp its mtime `ageHours` in the past. */
function writeAttachment(sha: string, ext: string, ageHours: number): string {
  const p = join(storeDir, `${sha}.${ext}`);
  writeFileSync(p, Buffer.from(`bytes-${sha}`));
  const when = (Date.now() - ageHours * HOUR) / 1000;
  utimesSync(p, when, when);
  return p;
}

describe("collectReferencedSha256", () => {
  it("unions every image sha256 across all session snapshots", () => {
    history.save(
      "s1",
      [
        { role: "user", content: "hi", images: [{ mime: "image/png", path: "x", sha256: SHA(1) }] },
      ] as never,
      [],
    );
    history.save(
      "s2",
      [
        {
          role: "user",
          content: "two",
          images: [{ mime: "image/png", path: "y", sha256: SHA(2) }],
        },
        { role: "assistant", content: "ok" },
      ] as never,
      [],
    );
    const set = collectReferencedSha256(db);
    expect([...set].sort()).toEqual([SHA(1), SHA(2)]);
  });

  it("returns an empty set when no snapshot carries images", () => {
    history.save("s1", [{ role: "user", content: "text only" }] as never, []);
    expect(collectReferencedSha256(db).size).toBe(0);
  });

  it("skips a row whose messages JSON is malformed without dropping other rows' references", () => {
    history.save(
      "s1",
      [
        { role: "user", content: "hi", images: [{ mime: "image/png", path: "x", sha256: SHA(1) }] },
      ] as never,
      [],
    );
    // A row whose messages column is not valid JSON — must be skipped, not throw or wipe the set.
    db.run(
      "INSERT INTO session_history (session_id, messages, todos, updated_at) VALUES (?, ?, ?, ?)",
      ["s2", "{not valid json", "[]", Date.now()],
    );
    const set = collectReferencedSha256(db);
    expect(set.has(SHA(1))).toBe(true); // the valid row's reference survived
    expect(set.size).toBe(1); // the malformed row contributed nothing and didn't abort the scan
  });
});

describe("findOrphans", () => {
  it("returns only unreferenced files older than the grace window; never touches referenced, recent, or non-attachment files", () => {
    const referencedOld = writeAttachment(SHA(1), "png", 100); // referenced → keep
    writeAttachment(SHA(2), "jpg", 100); // unreferenced + old → ORPHAN
    writeAttachment(SHA(3), "png", 1); // unreferenced + recent → keep (grace)
    writeFileSync(join(storeDir, "notes.txt"), "x"); // non-attachment → never touched
    const referenced = new Set([SHA(1)]);

    const orphans = findOrphans(storeDir, referenced, { now: Date.now(), minAgeMs: 24 * HOUR });
    expect(orphans.map((o) => o.path)).toEqual([join(storeDir, `${SHA(2)}.jpg`)]);
    expect(existsSync(referencedOld)).toBe(true);
  });

  it("returns [] when the attachments dir does not exist", () => {
    expect(findOrphans(join(dir, "nope"), new Set(), { now: Date.now(), minAgeMs: HOUR })).toEqual(
      [],
    );
  });
});

describe("gcAttachments", () => {
  it("dry-run reports orphans without deleting", () => {
    const orphan = writeAttachment(SHA(2), "png", 100);
    const res = gcAttachments({ storeDir, db, minAgeMs: 24 * HOUR, dryRun: true });
    expect(res).toMatchObject({ orphans: 1, deleted: 0 });
    expect(res.bytesReclaimed).toBeGreaterThan(0);
    expect(existsSync(orphan)).toBe(true);
  });

  it("real run deletes only the orphan", () => {
    history.save(
      "s1",
      [
        { role: "user", content: "hi", images: [{ mime: "image/png", path: "x", sha256: SHA(1) }] },
      ] as never,
      [],
    );
    const keep = writeAttachment(SHA(1), "png", 100);
    const orphan = writeAttachment(SHA(2), "png", 100);
    const res = gcAttachments({ storeDir, db, minAgeMs: 24 * HOUR, dryRun: false });
    expect(res).toMatchObject({ orphans: 1, deleted: 1 });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(keep)).toBe(true);
  });
});

describe("maybeGcOnStartup", () => {
  it("is a no-op when gcOnStartup is false", () => {
    const orphan = writeAttachment(SHA(2), "png", 100);
    const res = maybeGcOnStartup({ gcOnStartup: false, gcMinAgeHours: 24 }, storeDir, db);
    expect(res).toMatchObject({ orphans: 0, deleted: 0 });
    expect(existsSync(orphan)).toBe(true);
  });

  it("sweeps and reports when enabled", () => {
    const orphan = writeAttachment(SHA(2), "png", 100);
    const lines: string[] = [];
    const res = maybeGcOnStartup({ gcOnStartup: true, gcMinAgeHours: 24 }, storeDir, db, (l) =>
      lines.push(l),
    );
    expect(res.deleted).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(lines.join("\n")).toContain("attachments gc");
  });
});
