import { describe, expect, it } from "bun:test";
import {
  type HistoryState,
  historyNext,
  historyPrev,
  verticalNavigationTarget,
} from "../../../src/ui/tui/history-nav";

const history = ["first", "second", "third"];
const fresh: HistoryState = { value: "draft", histIdx: null, draft: "" };

describe("historyPrev", () => {
  it("recalls the newest entry and saves the current line as the draft", () => {
    expect(historyPrev(fresh, history)).toEqual({ value: "third", histIdx: 2, draft: "draft" });
  });

  it("walks further back, preserving the draft", () => {
    const at2 = { value: "third", histIdx: 2, draft: "draft" };
    expect(historyPrev(at2, history)).toEqual({ value: "second", histIdx: 1, draft: "draft" });
  });

  it("stops at the oldest entry", () => {
    const at0 = { value: "first", histIdx: 0, draft: "draft" };
    expect(historyPrev(at0, history)).toEqual(at0);
  });

  it("does nothing with empty history", () => {
    expect(historyPrev(fresh, [])).toEqual(fresh);
  });
});

describe("historyNext", () => {
  it("does nothing when not currently recalling", () => {
    expect(historyNext(fresh, history)).toEqual(fresh);
  });

  it("walks forward through history", () => {
    const at0 = { value: "first", histIdx: 0, draft: "draft" };
    expect(historyNext(at0, history)).toEqual({ value: "second", histIdx: 1, draft: "draft" });
  });

  it("restores the draft when walking past the newest entry", () => {
    const at2 = { value: "third", histIdx: 2, draft: "draft" };
    expect(historyNext(at2, history)).toEqual({ value: "draft", histIdx: null, draft: "draft" });
  });
});

describe("verticalNavigationTarget", () => {
  it("keeps navigating history when a recalled slash command has suggestions", () => {
    expect(
      verticalNavigationTarget({ suggestionCount: 1, multiline: false, recalling: true }),
    ).toBe("history");
  });

  it("keeps navigating history when a recalled prompt is multiline", () => {
    expect(verticalNavigationTarget({ suggestionCount: 0, multiline: true, recalling: true })).toBe(
      "history",
    );
  });

  it("otherwise prioritizes suggestions, then a multiline cursor, then history", () => {
    expect(
      verticalNavigationTarget({ suggestionCount: 2, multiline: true, recalling: false }),
    ).toBe("suggestions");
    expect(
      verticalNavigationTarget({ suggestionCount: 0, multiline: true, recalling: false }),
    ).toBe("cursor");
    expect(
      verticalNavigationTarget({ suggestionCount: 0, multiline: false, recalling: false }),
    ).toBe("history");
  });
});
