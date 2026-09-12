import { describe, expect, it } from "bun:test";
import { dice, nearMissHint } from "../../src/tools/near-miss";

describe("nearMissHint", () => {
  it("reports a whitespace-only indentation difference with the verbatim region", () => {
    const file = "function foo() {\n  return 1;\n}";
    const search = "function foo() {\nreturn 1;\n}"; // line 2 missing indentation
    const hint = nearMissHint(file, search);
    expect(hint).not.toBeNull();
    expect(hint).toContain("whitespace");
    expect(hint).toContain("lines 1–3");
    expect(hint).toContain("  return 1;"); // file's exact indented text
  });

  it("reports a trailing-whitespace difference via the whitespace branch", () => {
    const file = "alpha\nbeta\ngamma";
    const search = "alpha\nbeta  \ngamma"; // trailing spaces on beta
    const hint = nearMissHint(file, search);
    expect(hint).toContain("whitespace");
  });

  it("falls back to the closest region for a typo'd line", () => {
    const file = "const apple = 1;\nconst banana = 2;\nconst cherry = 3;";
    const search = "const bananna = 2;"; // typo
    const hint = nearMissHint(file, search);
    expect(hint).not.toBeNull();
    expect(hint).toContain("Closest match");
    expect(hint).toContain("const banana = 2;");
    expect(hint).toContain("lines 2–2");
  });

  it("returns null when the search text is genuinely absent", () => {
    expect(nearMissHint("alpha\nbeta\ngamma", "completely unrelated xyzzy plugh")).toBeNull();
  });

  it("returns null for empty search or empty file", () => {
    expect(nearMissHint("abc", "")).toBeNull();
    expect(nearMissHint("", "abc")).toBeNull();
  });

  it("truncates a long matched region with a count note", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const file = lines.map((l) => `  ${l}`).join("\n"); // indented
    const search = lines.join("\n"); // same content, no indent → whitespace match
    const hint = nearMissHint(file, search);
    expect(hint).toContain("…8 more lines");
  });

  it("anchors the fuzzy match on the longest non-blank line", () => {
    const file = "aa\nbb\nthe_quick_brown_fox_jumps\ncc";
    const search = "z\nthe_quick_brown_fox_jump\nz"; // anchor is the long middle line (typo)
    const hint = nearMissHint(file, search);
    expect(hint).toContain("Closest match");
    expect(hint).toContain("the_quick_brown_fox_jumps");
  });
});

describe("dice", () => {
  it("is 1 for identical strings", () => {
    expect(dice("hello", "hello")).toBe(1);
  });
  it("is 0 for disjoint strings", () => {
    expect(dice("abc", "xyz")).toBe(0);
  });
  it("is high but < 1 for a one-character typo", () => {
    const d = dice("banana", "bananna");
    expect(d).toBeGreaterThan(0.5);
    expect(d).toBeLessThan(1);
  });
});
