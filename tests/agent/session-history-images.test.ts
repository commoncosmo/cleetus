import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SessionHistoryStore } from "../../src/agent/session-history";

test("session history round-trips image refs and never persists base64", () => {
  const store = new SessionHistoryStore(new Database(":memory:"));
  const ref = { mime: "image/png", path: "/proj/.cleetus/attachments/abc.png", sha256: "abc" };
  store.save("S", [{ role: "user", content: "look", images: [ref] }], []);
  const snap = store.load("S");
  expect(snap?.messages[0]?.images?.[0]).toEqual(ref);
  // The persisted row references the file by path/hash only — no base64 payload.
  expect(JSON.stringify(snap?.messages)).not.toContain("data:image");
});
