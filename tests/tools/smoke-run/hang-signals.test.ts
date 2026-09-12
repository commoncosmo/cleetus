import { expect, test } from "bun:test";
import { HANG_SIGNALS, detectHangSignal } from "../../../src/tools/smoke-run/hang-signals";

test("matches the Tauri 'waiting for your frontend dev server' phrase (case-insensitive)", () => {
  const out = "Warn Waiting for your frontend dev server to start on http://localhost:1420/..";
  const hit = detectHangSignal(out);
  expect(hit).not.toBeNull();
  expect(hit!.hint).toContain("beforeDevCommand");
});

test("matches regardless of case and surrounding text", () => {
  const hit = detectHangSignal("foo\nWAITING FOR THE DEV SERVER\nbar");
  expect(hit).not.toBeNull();
});

test("returns null on healthy / unrelated output", () => {
  expect(detectHangSignal("VITE v6 ready in 312 ms\n➜ Local: http://localhost:1420/")).toBeNull();
  expect(detectHangSignal("Compiling app v0.1.0\nFinished dev profile")).toBeNull();
});

test("returns null on empty output", () => {
  expect(detectHangSignal("")).toBeNull();
});

test("HANG_SIGNALS is non-empty and every entry has a pattern and a hint", () => {
  expect(HANG_SIGNALS.length).toBeGreaterThan(0);
  for (const s of HANG_SIGNALS) {
    expect(s.pattern).toBeInstanceOf(RegExp);
    expect(typeof s.hint).toBe("string");
    expect(s.hint.length).toBeGreaterThan(0);
  }
});
