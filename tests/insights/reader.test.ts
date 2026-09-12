import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../src/events/log";
import { openEventSource } from "../../src/insights/reader";

test("openEventSource reads sessions written by EventLog", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleetus-reader-"));
  const dbPath = join(dir, "sessions.db");
  const log = new EventLog(dbPath);
  log.append({ sessionId: "s1", type: "user_input", payload: { text: "hi" } });
  log.append({ sessionId: "s1", type: "assistant_message", payload: { text: "ok" } });
  log.close();

  const source = openEventSource(dbPath);
  expect(source).not.toBeNull();
  expect(source!.listSessions()).toEqual(["s1"]);
  expect(source!.query("s1")).toHaveLength(2);
});

test("openEventSource returns null when the db file is missing", () => {
  expect(openEventSource(join(tmpdir(), "does-not-exist-cleetus", "sessions.db"))).toBeNull();
});
