import { expect, test } from "bun:test";

const appSrc = await Bun.file(new URL("../../../src/ui/tui/app.tsx", import.meta.url)).text();

test("Input's disabled gate goes through inputDisabled and no longer includes busy", () => {
  expect(appSrc).toMatch(/disabled=\{inputDisabled\(/);
  // The old expression started `disabled={ busy || ... }`. Its return is a
  // regression against Finding 9 (typing while busy must feed the queue).
  expect(appSrc).not.toMatch(/disabled=\{\s*busy/);
});

test("the queue is wired: enqueue on busy submit, resolveBoundary at idle, Esc drains", () => {
  expect(appSrc).toMatch(/enqueue\(/);
  expect(appSrc).toMatch(/resolveBoundary\(/);
  expect(appSrc).toMatch(/queuedLine\(/);
  // The Esc handler must drain the slot BEFORE aborting so the queued text
  // is never mistaken for deliverable at the boundary.
  expect(appSrc).toMatch(/drainQueueToInput\(\);\s*\n\s*abortRef\.current\?\.abort\(\)/);
});

test("every busy cycle resets the abort flag: setBusy(true) appears only inside beginBusy", () => {
  const matches = appSrc.match(/setBusy\(true\)/g) ?? [];
  expect(matches).toHaveLength(1);
});

test("busy flows that own an AbortController mark turnAbortedRef on abort", () => {
  // Every flow that assigns its own AbortController to abortRef.current (runPrompt,
  // runStructureAndTaskList, approveTaskList) must mirror runPrompt's finally-block
  // pattern, else an Esc during that flow's busy cycle leaves turnAbortedRef false and
  // a message queued during teardown auto-sends at the boundary (F9 review round 2).
  const owners = appSrc.match(/abortRef\.current = ac;/g) ?? [];
  const marks = appSrc.match(/if \(ac\.signal\.aborted\) turnAbortedRef\.current = true;/g) ?? [];
  expect(owners.length).toBeGreaterThanOrEqual(3); // runPrompt + runStructureAndTaskList + approveTaskList
  expect(marks.length).toBe(owners.length);
});
