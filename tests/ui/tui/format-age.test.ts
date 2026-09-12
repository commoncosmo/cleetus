import { describe, expect, it } from "bun:test";
import { formatAge } from "../../../src/ui/tui/format-age";

describe("formatAge", () => {
  it("formats sub-minute deltas as 'just now'", () => {
    expect(formatAge(0)).toBe("just now");
    expect(formatAge(59_000)).toBe("just now");
    expect(formatAge(-5_000)).toBe("just now"); // clamps negatives
  });
  it("formats minutes", () => {
    expect(formatAge(60_000)).toBe("1m ago");
    expect(formatAge(59 * 60_000)).toBe("59m ago");
  });
  it("formats hours", () => {
    expect(formatAge(60 * 60_000)).toBe("1h ago");
    expect(formatAge(23 * 60 * 60_000)).toBe("23h ago");
  });
  it("formats days", () => {
    expect(formatAge(24 * 60 * 60_000)).toBe("1d ago");
    expect(formatAge(3 * 24 * 60 * 60_000)).toBe("3d ago");
  });
});
