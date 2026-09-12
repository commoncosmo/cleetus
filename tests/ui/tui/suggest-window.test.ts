import { describe, expect, it } from "bun:test";
import { SUGGEST_PAGE, suggestWindow } from "../../../src/ui/tui/suggest-window";

describe("suggestWindow", () => {
  it("shows everything with no markers when total <= page", () => {
    expect(suggestWindow(5, 0)).toEqual({ offset: 0, aboveCount: 0, belowCount: 0 });
    expect(suggestWindow(SUGGEST_PAGE, 3)).toEqual({ offset: 0, aboveCount: 0, belowCount: 0 });
  });

  it("centers the window on a mid-list selection", () => {
    expect(suggestWindow(30, 15, 10)).toEqual({ offset: 10, aboveCount: 10, belowCount: 10 });
  });

  it("clamps at the start (selection 0)", () => {
    expect(suggestWindow(30, 0, 10)).toEqual({ offset: 0, aboveCount: 0, belowCount: 20 });
  });

  it("clamps at the end (last selection)", () => {
    expect(suggestWindow(30, 29, 10)).toEqual({ offset: 20, aboveCount: 20, belowCount: 0 });
  });

  it("holds the invariant above + visible + below === total for every selection", () => {
    const total = 27;
    const page = 10;
    for (let sel = 0; sel < total; sel++) {
      const w = suggestWindow(total, sel, page);
      const visible = Math.min(page, total);
      expect(w.aboveCount + visible + w.belowCount).toBe(total);
      expect(w.offset).toBeGreaterThanOrEqual(0);
      expect(w.offset).toBeLessThanOrEqual(total - page);
      expect(w.belowCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("defaults page to SUGGEST_PAGE", () => {
    expect(SUGGEST_PAGE).toBe(10);
    expect(suggestWindow(20, 0)).toEqual(suggestWindow(20, 0, SUGGEST_PAGE));
  });
});
