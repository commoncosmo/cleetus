import { afterEach, expect, test } from "bun:test";
import {
  FRAME_MS,
  advanceFrameClockForTest,
  framesFor,
  resetFrameClockForTest,
  subscribeFrameClock,
} from "../../../src/ui/tui/frame-clock";

afterEach(() => {
  resetFrameClockForTest();
});

test("rounds a requested interval to the frame grid, never below one frame", () => {
  expect(framesFor(FRAME_MS)).toBe(1);
  expect(framesFor(80)).toBe(1); // the old busy spinner
  expect(framesFor(50)).toBe(1); // the old count-up / live-stream flush
  expect(framesFor(120)).toBe(1); // the old reasoning spinner
  expect(framesFor(1000)).toBe(10); // the todo elapsed clock, exactly
  expect(framesFor(0)).toBe(1);
  expect(framesFor(-5)).toBe(1);
});

test("fires a per-frame subscriber on every tick", () => {
  let n = 0;
  subscribeFrameClock(FRAME_MS, () => n++);
  advanceFrameClockForTest(3);
  expect(n).toBe(3);
});

test("fires a slower subscriber only on its own beat", () => {
  let n = 0;
  subscribeFrameClock(1000, () => n++);
  advanceFrameClockForTest(9);
  expect(n).toBe(0);
  advanceFrameClockForTest(1);
  expect(n).toBe(1);
  advanceFrameClockForTest(10);
  expect(n).toBe(2);
});

test("subscribers at different cadences stay phase-aligned on the shared counter", () => {
  const fired: string[] = [];
  subscribeFrameClock(FRAME_MS, () => fired.push("fast"));
  subscribeFrameClock(1000, () => fired.push("slow"));
  advanceFrameClockForTest(10);
  // The slow beat lands inside the same tick as a fast beat — one frame, not two.
  expect(fired.filter((f) => f === "fast")).toHaveLength(10);
  expect(fired.filter((f) => f === "slow")).toHaveLength(1);
  expect(fired.slice(-2)).toEqual(["fast", "slow"]);
});

test("the disposer stops that subscriber and leaves the others running", () => {
  let a = 0;
  let b = 0;
  const stopA = subscribeFrameClock(FRAME_MS, () => a++);
  subscribeFrameClock(FRAME_MS, () => b++);

  advanceFrameClockForTest(1);
  expect([a, b]).toEqual([1, 1]);

  stopA();
  advanceFrameClockForTest(1);
  expect([a, b]).toEqual([1, 2]);
});

test("a subscriber may unsubscribe from inside its own callback", () => {
  let n = 0;
  const stop = subscribeFrameClock(FRAME_MS, () => {
    n++;
    if (n === 2) stop();
  });
  advanceFrameClockForTest(5);
  expect(n).toBe(2);
});

test("unsubscribing every subscriber stops the underlying timer", () => {
  const stop = subscribeFrameClock(FRAME_MS, () => {});
  // Bun keeps the process alive on a live interval; if this leaked, the suite would hang.
  stop();
  expect(() => advanceFrameClockForTest(1)).not.toThrow();
});
