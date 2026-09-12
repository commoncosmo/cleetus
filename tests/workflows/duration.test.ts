import { describe, expect, it } from "bun:test";
import { parseWorkflowDuration } from "../../src/workflows/duration";

describe("parseWorkflowDuration", () => {
  it("parses the supported units", () => {
    expect(parseWorkflowDuration("15ms")).toBe(15);
    expect(parseWorkflowDuration("2s")).toBe(2_000);
    expect(parseWorkflowDuration("3m")).toBe(180_000);
  });

  it("rejects zero, fractions, unitless values, and unknown units", () => {
    for (const value of ["0s", "-1s", "1.5s", "5", "1h", ""]) {
      expect(() => parseWorkflowDuration(value)).toThrow();
    }
  });

  it("rejects non-strings and unsafe values", () => {
    expect(() => parseWorkflowDuration(5)).toThrow("must be a duration string");
    expect(() => parseWorkflowDuration(`${Number.MAX_SAFE_INTEGER}m`)).toThrow(
      "outside the supported range",
    );
  });
});
