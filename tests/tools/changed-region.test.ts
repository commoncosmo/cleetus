import { describe, expect, it } from "bun:test";
import { appendRegion, changedRegion } from "../../src/tools/changed-region";

describe("changedRegion", () => {
  it("returns a numbered excerpt with ±3 context around a single changed line", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "b", "c", "CHANGED", "e", "f", "g"].join("\n");
    const out = changedRegion(before, after)!;
    expect(out).toContain("4\tCHANGED");
    expect(out).toContain("1\ta"); // line 4 - 3 context = line 1
    expect(out).toContain("7\tg"); // line 4 + 3 context = line 7
  });
  it("spans multiple contiguous changed lines into one region", () => {
    const before = ["a", "b", "c", "d"].join("\n");
    const after = ["a", "X", "Y", "d"].join("\n");
    const out = changedRegion(before, after)!;
    expect(out).toContain("2\tX");
    expect(out).toContain("3\tY");
  });
  it("returns null when the changed span exceeds maxLines", () => {
    const before = Array.from({ length: 200 }, (_, i) => `L${i}`).join("\n");
    const after = before.replace("L0", "TOP").replace("L199", "BOTTOM"); // span ~200 lines
    expect(changedRegion(before, after, 3, 80)).toBeNull();
  });
  it("returns null when before === after", () => {
    expect(changedRegion("a\nb", "a\nb")).toBeNull();
  });
  it("handles an inserted line (after is longer than before)", () => {
    const out = changedRegion("a\nb\nc", "a\nb\nB2\nc")!;
    expect(out).toContain("3\tB2");
    expect(out).toContain("1\ta");
  });
  it("handles a deleted line (after is shorter than before)", () => {
    const out = changedRegion("a\nb\nc\nd", "a\nc\nd")!;
    // line 2 of the after-file ("c") is where the deletion surfaces
    expect(out).toContain("2\tc");
  });
  it("returns null (not empty string) for a deletion with zero context", () => {
    expect(changedRegion("X\na\nb\nc", "a\nb\nc", 0)).toBeNull();
  });
});

describe("appendRegion", () => {
  it("appends the region on a normal edit", () => {
    const out = appendRegion("edited x (1 replacement)", "a\nb\nc", "a\nZ\nc");
    expect(out).toContain("edited x (1 replacement)");
    expect(out).toContain("2\tZ");
  });
  it("appends a fallback note when the region is too large to inline", () => {
    const before = Array.from({ length: 200 }, (_, i) => `L${i}`).join("\n");
    const after = before.replace("L0", "TOP").replace("L199", "BOTTOM");
    const out = appendRegion("edited x", before, after);
    expect(out).toContain("re-read");
  });
});
