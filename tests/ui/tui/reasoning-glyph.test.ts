import { describe, expect, it } from "bun:test";
import {
  SPINNER_FRAMES,
  THINKING_DONE_GLYPH,
  spinnerFrame,
} from "../../../src/ui/tui/reasoning-glyph";

describe("spinnerFrame", () => {
  it("returns the frame at the given tick", () => {
    expect(spinnerFrame(0)).toBe("◐");
    expect(spinnerFrame(1)).toBe("◓");
    expect(spinnerFrame(2)).toBe("◑");
    expect(spinnerFrame(3)).toBe("◒");
  });
  it("wraps around past the last frame", () => {
    expect(spinnerFrame(4)).toBe("◐");
    expect(spinnerFrame(5)).toBe("◓");
  });
  it("handles negative ticks without throwing", () => {
    expect(spinnerFrame(-1)).toBe("◒"); // wraps to the last frame
  });
});

describe("glyph constants", () => {
  it("has four single-width quadrant frames", () => {
    expect(SPINNER_FRAMES).toHaveLength(4);
  });
  it("uses a solid dot for the completed marker", () => {
    expect(THINKING_DONE_GLYPH).toBe("●");
  });
});
