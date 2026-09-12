import { describe, expect, test } from "bun:test";
import { rewindRows } from "../../../src/ui/tui/rewind-row";

describe("rewindRows", () => {
  const now = 100_000;
  const cps = [
    { turnNumber: 0, userInput: "first thing", ts: now - 15 * 60_000 },
    { turnNumber: 1, userInput: "second   thing\nwith newline", ts: now - 8 * 60_000 },
    { turnNumber: 2, userInput: "x".repeat(80), ts: now - 30_000 },
  ];

  test("newest first", () => {
    expect(rewindRows(cps, now).map((r) => r.turnNumber)).toEqual([2, 1, 0]);
  });

  test("ages are relative labels", () => {
    const rows = rewindRows(cps, now);
    expect(rows[0]!.age).toBe("just now");
    expect(rows[1]!.age).toBe("8m ago");
    expect(rows[2]!.age).toBe("15m ago");
  });

  test("labels collapse whitespace and truncate", () => {
    const rows = rewindRows(cps, now);
    expect(rows[1]!.label).toBe("second thing with newline");
    expect(rows[0]!.label.length).toBeLessThanOrEqual(40);
    expect(rows.find((r) => r.turnNumber === 2)!.label.endsWith("…")).toBe(true);
  });
});
