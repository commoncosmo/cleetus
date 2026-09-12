import { describe, expect, it } from "bun:test";
import { easedValue } from "../../../src/ui/tui/count-up";

describe("easedValue", () => {
  it("returns `from` at elapsed 0", () => {
    expect(easedValue(100, 900, 0, 400)).toBe(100);
  });

  it("returns exactly `to` once elapsed >= duration", () => {
    expect(easedValue(100, 900, 400, 400)).toBe(900);
    expect(easedValue(100, 900, 9999, 400)).toBe(900);
  });

  it("returns exactly `to` when duration <= 0", () => {
    expect(easedValue(100, 900, 0, 0)).toBe(900);
    expect(easedValue(100, 900, 0, -5)).toBe(900);
  });

  it("returns an integer mid-animation", () => {
    const v = easedValue(0, 1000, 137, 400);
    expect(Number.isInteger(v)).toBe(true);
  });

  it("is non-decreasing across the interval for to > from", () => {
    let prev = -1;
    for (let t = 0; t <= 400; t += 20) {
      const v = easedValue(0, 1000, t, 400);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("ease-out: midpoint is past the linear halfway point", () => {
    // Linear midpoint of 0->1000 would be 500; ease-out should be higher.
    expect(easedValue(0, 1000, 200, 400)).toBeGreaterThan(500);
  });

  it("handles a target lower than from by clamping to `to`", () => {
    // Defensive: counters only increase, but never display below target.
    expect(easedValue(500, 300, 0, 400)).toBe(500);
    expect(easedValue(500, 300, 400, 400)).toBe(300);
  });
});
