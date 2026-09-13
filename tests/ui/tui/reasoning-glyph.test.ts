import { describe, expect, it } from "bun:test";
import { THINKING_DONE_GLYPH, THINKING_LIVE_GLYPH } from "../../../src/ui/tui/reasoning-glyph";

describe("glyph constants", () => {
  it("uses a stable marker while reasoning is live", () => {
    expect(THINKING_LIVE_GLYPH).toBe("◌");
  });
  it("uses a solid dot for the completed marker", () => {
    expect(THINKING_DONE_GLYPH).toBe("●");
  });
});
