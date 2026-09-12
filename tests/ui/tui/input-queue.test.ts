import { expect, test } from "bun:test";
import {
  enqueue,
  joinForPrefill,
  queuedLine,
  resolveBoundary,
} from "../../../src/ui/tui/input-queue";

test("enqueue fills an empty slot", () => {
  expect(enqueue(null, "run the tests")).toBe("run the tests");
  expect(enqueue("", "run the tests")).toBe("run the tests");
});

test("enqueue appends to a non-empty slot with a newline — never replaces", () => {
  expect(enqueue("run the tests", "then lint")).toBe("run the tests\nthen lint");
});

test("boundary: empty slot does nothing", () => {
  expect(resolveBoundary({ queued: null, aborted: false, hasPendingPrompt: false })).toBe("none");
  expect(resolveBoundary({ queued: "", aborted: false, hasPendingPrompt: false })).toBe("none");
});

test("boundary: clean or error end with nothing pending delivers", () => {
  expect(resolveBoundary({ queued: "next", aborted: false, hasPendingPrompt: false })).toBe(
    "deliver",
  );
});

test("boundary: a pending prompt pre-fills — never auto-sends into a prompt", () => {
  expect(resolveBoundary({ queued: "next", aborted: false, hasPendingPrompt: true })).toBe(
    "prefill",
  );
});

test("boundary: an aborted turn pre-fills even with nothing pending (defensive belt)", () => {
  expect(resolveBoundary({ queued: "next", aborted: true, hasPendingPrompt: false })).toBe(
    "prefill",
  );
  expect(resolveBoundary({ queued: "next", aborted: true, hasPendingPrompt: true })).toBe(
    "prefill",
  );
});

test("queuedLine shows the first line, marking multiline text", () => {
  expect(queuedLine("run the tests")).toBe("run the tests");
  expect(queuedLine("run the tests\nthen lint")).toBe("run the tests …");
});

test("joinForPrefill puts queued text before in-progress buffer text", () => {
  expect(joinForPrefill("queued msg", "half-typed")).toBe("queued msg\nhalf-typed");
});

test("joinForPrefill with a blank buffer is just the queued text", () => {
  expect(joinForPrefill("queued msg", "")).toBe("queued msg");
  expect(joinForPrefill("queued msg", "   ")).toBe("queued msg");
});
