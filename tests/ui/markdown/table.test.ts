import { describe, expect, it } from "bun:test";
import {
  MIN_COL_WIDTH,
  bottomBorder,
  displayWidth,
  fitColumns,
  frameOverhead,
  layoutTable,
  midBorder,
  shouldStack,
  stableTableSpans,
  stableTableText,
  tableAvailableWidth,
  topBorder,
  truncateToWidth,
} from "../../../src/ui/markdown/table";
import type { Span } from "../../../src/ui/markdown/types";

const cell = (text: string): Span[] => [{ text }];

describe("displayWidth", () => {
  it("counts ascii as 1 each", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("")).toBe(0);
  });
  it("counts a CJK char as 2", () => {
    expect(displayWidth("中")).toBe(2);
    expect(displayWidth("a中b")).toBe(4);
  });
  it("counts an emoji as 2", () => {
    expect(displayWidth("🙂")).toBe(2);
  });
  it("matches terminal widths for emoji presentation and combining sequences", () => {
    expect(displayWidth("0 ✅")).toBe(4);
    expect(displayWidth("1 ⚠️")).toBe(4);
    expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(displayWidth("e\u0301")).toBe(1);
  });
});

describe("stableTableText", () => {
  it("uses cursor-stable status glyphs in bordered grids", () => {
    expect(stableTableText("⚠️ Medium")).toBe("! Medium");
    expect(stableTableText("✅ Fixed / ❌ Unfixed")).toBe("✓ Fixed / ✗ Unfixed");
    expect(stableTableText("⏸️ Deferred · ⚙️ Other")).toBe("‖ Deferred · * Other");
  });

  it("replaces other emoji graphemes without changing surrounding text or span styles", () => {
    expect(stableTableText("Family 👨‍👩‍👧‍👦")).toBe("Family *");
    expect(stableTableSpans([{ text: "✅ Fixed", bold: true, code: true }])).toEqual([
      { text: "✓ Fixed", bold: true, code: true },
    ]);
  });
});

describe("truncateToWidth", () => {
  it("returns the string unchanged when it fits", () => {
    expect(truncateToWidth("abc", 5)).toBe("abc");
    expect(truncateToWidth("abc", 3)).toBe("abc");
  });
  it("truncates with an ellipsis when too long", () => {
    expect(truncateToWidth("abcdef", 4)).toBe("abc…");
    expect(displayWidth(truncateToWidth("abcdef", 4))).toBeLessThanOrEqual(4);
  });
  it("never splits a grapheme cluster", () => {
    expect(truncateToWidth("A👨‍👩‍👧‍👦BC", 4)).toBe("A👨‍👩‍👧‍👦…");
    expect(truncateToWidth("e\u0301x", 2)).toBe("e\u0301x");
  });
});

describe("layoutTable", () => {
  it("sizes each column to its widest cell across header and rows", () => {
    const headers = [cell("Name"), cell("X")];
    const rows = [
      [cell("Alice"), cell("1")],
      [cell("Bo"), cell("22")],
    ];
    expect(layoutTable(headers, rows).widths).toEqual([5, 2]);
  });
  it("uses the full natural width of a long cell (no cap)", () => {
    const headers = [cell("H")];
    const rows = [[cell("x".repeat(100))]];
    expect(layoutTable(headers, rows).widths).toEqual([100]);
  });
  it("handles ragged rows (missing cells) without breaking", () => {
    const headers = [cell("A"), cell("B")];
    const rows = [[cell("longvalue")]];
    expect(layoutTable(headers, rows).widths).toEqual([9, 1]);
  });
  it("derives widths from headers when there are no rows", () => {
    expect(layoutTable([cell("Hello"), cell("Hi")], []).widths).toEqual([5, 2]);
  });
});

describe("tableAvailableWidth", () => {
  it("reserves the final terminal column to avoid automatic line wrapping", () => {
    expect(tableAvailableWidth(80)).toBe(79);
    expect(tableAvailableWidth(1)).toBe(1);
    expect(tableAvailableWidth(0)).toBe(1);
  });
});

describe("fitColumns", () => {
  it("returns natural widths unchanged when they fit the budget", () => {
    expect(fitColumns([10, 10, 10], 80, 3)).toEqual([10, 10, 10]);
  });

  it("shrinks the widest column(s) first when over budget, leaving narrow ones", () => {
    const out = fitColumns([5, 5, 40], 30, 3);
    expect(out[0]).toBe(5);
    expect(out[1]).toBe(5);
    expect(out[2]).toBe(14);
    expect(out.reduce((a, b) => a + b, 0) + 3 * 2).toBeLessThanOrEqual(30);
  });

  it("never shrinks a column below MIN_COL_WIDTH", () => {
    const out = fitColumns([50, 50], 10, 3);
    expect(out.every((w) => w >= MIN_COL_WIDTH)).toBe(true);
    expect(out).toEqual([MIN_COL_WIDTH, MIN_COL_WIDTH]);
  });

  it("returns [] for zero columns", () => {
    expect(fitColumns([], 80, 3)).toEqual([]);
  });

  it("shrinks a lone column to fit (no separators)", () => {
    expect(fitColumns([100], 40, 3)).toEqual([40]);
    expect(fitColumns([20], 80, 3)).toEqual([20]);
  });
});

describe("frameOverhead", () => {
  it("is 3n+1 for a box table, 0 for no columns", () => {
    expect(frameOverhead(0)).toBe(0);
    expect(frameOverhead(1)).toBe(4);
    expect(frameOverhead(3)).toBe(10);
  });
});

describe("box border builders", () => {
  it("build top/mid/bottom borders with w+2 segments and correct corners", () => {
    expect(topBorder([3, 3])).toBe("┌─────┬─────┐");
    expect(midBorder([3, 3])).toBe("├─────┼─────┤");
    expect(bottomBorder([3, 3])).toBe("└─────┴─────┘");
  });
  it("border display width equals sum(widths) + frameOverhead", () => {
    const widths = [5, 8, 4];
    const expected = widths.reduce((a, b) => a + b, 0) + frameOverhead(widths.length);
    expect(displayWidth(topBorder(widths))).toBe(expected);
    expect(displayWidth(midBorder(widths))).toBe(expected);
    expect(displayWidth(bottomBorder(widths))).toBe(expected);
  });
});

describe("shouldStack", () => {
  it("is true only when n columns cannot fit at MIN_COL_WIDTH + frame", () => {
    // n=3 → min content 18, frame 10 → threshold 28.
    expect(shouldStack(3, 28)).toBe(false);
    expect(shouldStack(3, 27)).toBe(true);
  });
  it("is false for zero or negative column counts", () => {
    expect(shouldStack(0, 1)).toBe(false);
    expect(shouldStack(-1, 1)).toBe(false);
  });
});

describe("fitColumns with box overhead (outerPad)", () => {
  it("subtracts outerPad from the budget", () => {
    // sepTotal = 3*(n-1) + 4 = frameOverhead(n). 3 cols of 10 + frame 10 = 40 ≤ 80.
    expect(fitColumns([10, 10, 10], 80, 3, 4)).toEqual([10, 10, 10]);
  });
  it("shrinks to fit within termWidth minus frame", () => {
    const out = fitColumns([40, 40], 30, 3, 4);
    const total = out.reduce((a, b) => a + b, 0);
    expect(out.every((w) => w >= MIN_COL_WIDTH)).toBe(true);
    expect(total + frameOverhead(out.length)).toBeLessThanOrEqual(30);
  });
});
