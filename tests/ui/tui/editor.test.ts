import { describe, expect, it } from "bun:test";
import {
  type Buffer,
  backspace,
  down,
  insert,
  isMultiline,
  left,
  normalizeInput,
  right,
  up,
  visualLayout,
} from "../../../src/ui/tui/editor";

describe("normalizeInput", () => {
  it("preserves pasted line breaks, blank lines, and tab indentation", () => {
    expect(normalizeInput("first\r\n\r\n\tindented\rnext")).toBe("first\n\n\tindented\nnext");
  });

  it("removes bracketed-paste framing and unsafe control bytes", () => {
    const esc = String.fromCharCode(27);
    expect(normalizeInput(`${esc}[200~hello${String.fromCharCode(0)}\nworld${esc}[201~`)).toBe(
      "hello\nworld",
    );
    // Ink strips a leading escape byte before handing the sequence to useInput.
    expect(normalizeInput("[200~hello\nworld[201~")).toBe("hello\nworld");
  });
});

describe("insert", () => {
  it("inserts at the cursor and advances it", () => {
    expect(insert({ text: "ac", cursor: 1 }, "b")).toEqual({ text: "abc", cursor: 2 });
  });
  it("inserts a newline at the cursor", () => {
    expect(insert({ text: "ab", cursor: 1 }, "\n")).toEqual({ text: "a\nb", cursor: 2 });
  });
});

describe("backspace", () => {
  it("deletes the character before the cursor", () => {
    expect(backspace({ text: "abc", cursor: 2 })).toEqual({ text: "ac", cursor: 1 });
  });
  it("merges lines when deleting a newline at a line start", () => {
    expect(backspace({ text: "a\nb", cursor: 2 })).toEqual({ text: "ab", cursor: 1 });
  });
  it("does nothing at the start", () => {
    expect(backspace({ text: "abc", cursor: 0 })).toEqual({ text: "abc", cursor: 0 });
  });
});

describe("left/right", () => {
  it("moves within bounds", () => {
    expect(left({ text: "abc", cursor: 2 }).cursor).toBe(1);
    expect(right({ text: "abc", cursor: 2 }).cursor).toBe(3);
  });
  it("clamps at the ends", () => {
    expect(left({ text: "abc", cursor: 0 }).cursor).toBe(0);
    expect(right({ text: "abc", cursor: 3 }).cursor).toBe(3);
  });
});

describe("up/down", () => {
  const buf: Buffer = { text: "hello\nworld\n!", cursor: 0 };

  it("moves to the same column on the adjacent line", () => {
    // cursor on row 1 col 3 ("wor|ld") -> up to row 0 col 3 ("hel|lo")
    expect(up({ text: "hello\nworld", cursor: 9 })).toEqual({ text: "hello\nworld", cursor: 3 });
    // and back down
    expect(down({ text: "hello\nworld", cursor: 3 })).toEqual({ text: "hello\nworld", cursor: 9 });
  });

  it("clamps the column to a shorter target line", () => {
    // cursor on row 1 col 5 ("world|") -> down to row 2 ("!"), clamped to col 1
    expect(down({ text: "hello\nworld\n!", cursor: 11 }).cursor).toBe(13);
  });

  it("up on the first line goes to the start", () => {
    expect(up({ text: "hello\nworld", cursor: 3 }).cursor).toBe(0);
  });

  it("down on the last line goes to the end", () => {
    expect(down({ text: "hello\nworld", cursor: 8 }).cursor).toBe(11);
  });

  it("ignores the unused fixture", () => {
    expect(isMultiline(buf)).toBe(true);
  });
});

describe("isMultiline", () => {
  it("is true only with a newline", () => {
    expect(isMultiline({ text: "one line", cursor: 0 })).toBe(false);
    expect(isMultiline({ text: "two\nlines", cursor: 0 })).toBe(true);
  });
});

describe("visualLayout", () => {
  it("leaves a short line unwrapped", () => {
    expect(visualLayout({ text: "abc", cursor: 3 }, 80)).toEqual({
      rows: ["abc"],
      cursorRow: 0,
      cursorCol: 3,
    });
  });

  it("splits on explicit newlines", () => {
    expect(visualLayout({ text: "ab\ncd", cursor: 4 }, 80)).toEqual({
      rows: ["ab", "cd"],
      cursorRow: 1,
      cursorCol: 1,
    });
  });

  it("wraps at word boundaries without splitting a word that fits", () => {
    expect(visualLayout({ text: "hello wonderful world", cursor: 21 }, 12)).toEqual({
      rows: ["hello", "wonderful", "world"],
      cursorRow: 2,
      cursorCol: 5,
    });
  });

  it("places a continuation cursor relative to a soft-wrapped word", () => {
    expect(visualLayout({ text: "hello wonderful", cursor: 9 }, 10)).toEqual({
      rows: ["hello", "wonderful"],
      cursorRow: 1,
      cursorCol: 3,
    });
  });

  it("preserves leading indentation while wrapping", () => {
    expect(visualLayout({ text: "    indented text", cursor: 17 }, 12)).toEqual({
      rows: ["    indented", "text"],
      cursorRow: 1,
      cursorCol: 4,
    });
  });

  it("wraps a long line and places the end cursor on the wrapped row", () => {
    // The reported bug: cursor at the end of a wrapped line must land on the
    // continuation row, not at the end of the first visual row.
    expect(visualLayout({ text: "abcdefghij", cursor: 10 }, 5)).toEqual({
      rows: ["abcde", "fghij"],
      cursorRow: 1,
      cursorCol: 5,
    });
  });

  it("places a mid-continuation cursor correctly", () => {
    expect(visualLayout({ text: "abcdefgh", cursor: 7 }, 5)).toEqual({
      rows: ["abcde", "fgh"],
      cursorRow: 1,
      cursorCol: 2,
    });
  });

  it("places the cursor at the start of a continuation row", () => {
    expect(visualLayout({ text: "abcdefgh", cursor: 5 }, 5)).toEqual({
      rows: ["abcde", "fgh"],
      cursorRow: 1,
      cursorCol: 0,
    });
  });

  it("keeps a cursor on the first visual row of a wrapped line", () => {
    expect(visualLayout({ text: "abcdefgh", cursor: 3 }, 5)).toEqual({
      rows: ["abcde", "fgh"],
      cursorRow: 0,
      cursorCol: 3,
    });
  });

  it("puts the end cursor at the right edge of an exactly-full line", () => {
    expect(visualLayout({ text: "abcde", cursor: 5 }, 5)).toEqual({
      rows: ["abcde"],
      cursorRow: 0,
      cursorCol: 5,
    });
  });

  it("locates the cursor on a logical line after a wrapped one", () => {
    expect(visualLayout({ text: "abcdefg\nxy", cursor: 10 }, 5)).toEqual({
      rows: ["abcde", "fg", "xy"],
      cursorRow: 2,
      cursorCol: 2,
    });
  });

  it("renders an empty buffer as a single empty row", () => {
    expect(visualLayout({ text: "", cursor: 0 }, 80)).toEqual({
      rows: [""],
      cursorRow: 0,
      cursorCol: 0,
    });
  });

  it("treats a non-positive width as 1", () => {
    expect(visualLayout({ text: "ab", cursor: 2 }, 0)).toEqual({
      rows: ["a", "b"],
      cursorRow: 1,
      cursorCol: 1,
    });
  });
});
