import { expect, test } from "bun:test";
import { SessionReadCache } from "../../src/agent/read-cache";

test("first read of a path returns the full body, not elided", () => {
  const c = new SessionReadCache();
  const r = c.reconcile("/a", "X", 5, 0);
  expect(r.elided).toBe(false);
  expect(r.content).toBe("X");
});

test("an unchanged in-window re-read is elided to a note", () => {
  const c = new SessionReadCache();
  c.reconcile("/a", "X", 5, 0); // bodyIndex = 5
  const r = c.reconcile("/a", "X", 9, 0); // boundary 0 <= bodyIndex 5 → in window
  expect(r.elided).toBe(true);
  expect(r.content).toContain("/a");
  expect(r.content).toContain("unchanged");
  expect(r.content).not.toContain("X\n"); // body omitted
});

test("the third+ in-window re-read escalates to a STOP note with the count", () => {
  const c = new SessionReadCache();
  c.reconcile("/a", "X", 1, 0); // 1, full body
  c.reconcile("/a", "X", 2, 0); // 2 → "unchanged"
  const third = c.reconcile("/a", "X", 3, 0); // 3 → STOP
  expect(third.elided).toBe(true);
  expect(third.content).toContain("STOP");
  expect(third.content).toContain("3");
});

test("a re-read whose body fell below the boundary re-sends the full body", () => {
  const c = new SessionReadCache();
  c.reconcile("/a", "X", 5, 0); // bodyIndex = 5
  const out = c.reconcile("/a", "X", 9, 8); // boundary 8 > bodyIndex 5 → out of window
  expect(out.elided).toBe(false);
  expect(out.content).toBe("X");
  // Re-sent body is now stamped at index 9; a fresh in-window re-read elides again.
  const again = c.reconcile("/a", "X", 12, 8);
  expect(again.elided).toBe(true);
});

test("changed content re-sends the body and resets the escalation", () => {
  const c = new SessionReadCache();
  c.reconcile("/a", "X", 1, 0);
  const changed = c.reconcile("/a", "Y", 2, 0); // edit → new hash
  expect(changed.elided).toBe(false);
  expect(changed.content).toBe("Y");
  const reread = c.reconcile("/a", "Y", 3, 0); // unchanged again
  expect(reread.elided).toBe(true);
  expect(reread.content).toContain("unchanged");
  expect(reread.content).not.toContain("STOP");
});

test("different paths are tracked independently", () => {
  const c = new SessionReadCache();
  c.reconcile("/a", "X", 5, 0);
  expect(c.reconcile("/b", "X", 9, 0).elided).toBe(false);
});

test("does not elide when the body exceeds the live cap", () => {
  const c = new SessionReadCache();
  const body = "x".repeat(100);
  expect(c.reconcile("/p/a.ts", body, 5, 0, 50).elided).toBe(false); // first read
  const r = c.reconcile("/p/a.ts", body, 6, 0, 50); // unchanged, in window, but > cap
  expect(r.elided).toBe(false);
  expect(r.content).toBe(body);
});

test("elides when the body fits the live cap", () => {
  const c = new SessionReadCache();
  const body = "x".repeat(100);
  c.reconcile("/p/a.ts", body, 5, 0, 500);
  expect(c.reconcile("/p/a.ts", body, 6, 0, 500).elided).toBe(true);
});

test("omitted live cap keeps today's behavior", () => {
  const c = new SessionReadCache();
  const body = "x".repeat(100_000);
  c.reconcile("/p/a.ts", body, 5, 0);
  expect(c.reconcile("/p/a.ts", body, 6, 0).elided).toBe(true);
});
