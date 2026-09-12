import { describe, expect, it } from "bun:test";
import { displayWidth } from "../../../src/ui/markdown/table";
import type { Span } from "../../../src/ui/markdown/types";
import { wrapSpans } from "../../../src/ui/markdown/wrap";

const text = (line: Span[]): string => line.map((s) => s.text).join("");

describe("wrapSpans", () => {
  it("returns a single line when everything fits", () => {
    const out = wrapSpans([{ text: "hello world" }], 20);
    expect(out.length).toBe(1);
    expect(text(out[0]!)).toBe("hello world");
  });

  it("word-wraps at the width boundary", () => {
    const out = wrapSpans([{ text: "the quick brown fox" }], 9);
    expect(out.map(text)).toEqual(["the quick", "brown fox"]);
  });

  it("hard-breaks a single word longer than the width", () => {
    const out = wrapSpans([{ text: "supercalifragilistic" }], 8);
    expect(out.every((l) => text(l).length <= 8)).toBe(true);
    expect(out.map(text).join("")).toBe("supercalifragilistic");
  });

  it("preserves span styling across a wrap", () => {
    const out = wrapSpans([{ text: "bold here", bold: true, color: "cyan" }], 4);
    for (const line of out) {
      for (const span of line) {
        expect(span.bold).toBe(true);
        expect(span.color).toBe("cyan");
      }
    }
  });

  it("measures wide characters as width 2", () => {
    // Four CJK chars = display width 8; at width 4 only two fit per line.
    const out = wrapSpans([{ text: "中文字符" }], 4);
    expect(out.length).toBe(2);
    expect(text(out[0]!)).toBe("中文");
  });

  it("returns one empty line for an empty cell", () => {
    expect(wrapSpans([], 10)).toEqual([[]]);
    expect(wrapSpans([{ text: "   " }], 10)).toEqual([[]]);
  });

  it("hard-breaks a long CJK string by display width", () => {
    // 6 CJK chars = display width 12; at width 4 each line holds 2 chars.
    const out = wrapSpans([{ text: "一二三四五六" }], 4);
    expect(out.every((l) => displayWidth(text(l)) <= 4)).toBe(true);
    expect(out.map(text).join("")).toBe("一二三四五六");
  });

  it("terminates (no infinite loop) when a wide char exceeds a width-1 budget", () => {
    const out = wrapSpans([{ text: "中文" }], 1);
    expect(out.map(text).join("")).toBe("中文");
    expect(out.length).toBe(2);
  });

  it("keeps emoji and combining graphemes intact while hard-wrapping", () => {
    const family = "👨‍👩‍👧‍👦";
    const out = wrapSpans([{ text: `${family}${family}e\u0301` }], 2);
    expect(out.map(text)).toEqual([family, family, "e\u0301"]);
    expect(out.every((line) => displayWidth(text(line)) <= 2)).toBe(true);
  });
});
