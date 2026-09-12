import { describe, expect, it } from "bun:test";
import { applyUpdate } from "../../../src/tools/apply-patch/apply";
import type { HunkLine, PatchHunk } from "../../../src/tools/apply-patch/parse";

const ctx = (text: string): HunkLine => ({ kind: "context", text });
const del = (text: string): HunkLine => ({ kind: "del", text });
const add = (text: string): HunkLine => ({ kind: "add", text });
const hunk = (...lines: HunkLine[]): PatchHunk => ({ lines });

describe("applyUpdate", () => {
  it("applies an exact-match hunk", () => {
    const r = applyUpdate("a\nb\nc\n", [hunk(ctx("a"), del("b"), add("B"), ctx("c"))]);
    expect(r).toEqual({ ok: true, after: "a\nB\nc\n" });
  });

  it("matches despite trailing-whitespace differences, preserving the file's context line", () => {
    const r = applyUpdate("a  \nb\nc\n", [hunk(ctx("a"), del("b"), add("X"))]);
    // The context line keeps the file's original "a  " (not the hunk's trimmed "a").
    expect(r).toEqual({ ok: true, after: "a  \nX\nc\n" });
  });

  it("matches despite surrounding-whitespace differences, preserving the file's context line", () => {
    const r = applyUpdate("   a\nb\n", [hunk(ctx("a"), del("b"), add("Z"))]);
    expect(r).toEqual({ ok: true, after: "   a\nZ\n" });
  });

  it("applies multiple hunks in order", () => {
    const r = applyUpdate("x\ny\np\nq\n", [
      hunk(ctx("x"), del("y"), add("Y")),
      hunk(del("p"), add("P"), ctx("q")),
    ]);
    expect(r).toEqual({ ok: true, after: "x\nY\nP\nq\n" });
  });

  it("advances the cursor correctly after a hunk that grows the file", () => {
    // Hunk 1 adds a net line (1 context+1 del → 1 context+2 add); hunk 2 must still find "d" after.
    const r = applyUpdate("a\nb\nc\nd\n", [
      hunk(ctx("a"), del("b"), add("B1"), add("B2")),
      hunk(del("d"), add("D")),
    ]);
    expect(r).toEqual({ ok: true, after: "a\nB1\nB2\nc\nD\n" });
  });

  it("fails (no mutation) when a hunk can't be located", () => {
    const r = applyUpdate("a\nb\n", [hunk(del("nope"), del("missing"), add("x"))]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain("locate");
  });

  it("fails when a hunk has no context to anchor an insertion", () => {
    const r = applyUpdate("a\nb\n", [hunk(add("inserted"))]);
    expect(r.ok).toBe(false);
  });

  it("preserves a file without a trailing newline", () => {
    const r = applyUpdate("a\nb", [hunk(ctx("a"), del("b"), add("B"))]);
    expect(r).toEqual({ ok: true, after: "a\nB" });
  });

  it("attaches a near-miss hint when a hunk's del line is a typo of a real line", () => {
    // File has `const banana = 2;`; the hunk's del line has a typo → genuine locate failure.
    const r = applyUpdate("const banana = 2;\n", [
      hunk(del("const bananna = 2;"), add("const banana = 9;")),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("could not be located");
      expect(r.reason).toContain("Closest match");
      expect(r.reason).toContain("const banana = 2;");
    }
  });

  it("preserves CRLF endings, terminating added lines to match the file", () => {
    const r = applyUpdate("a\r\nb\r\nc\r\n", [hunk(ctx("a"), del("b"), add("B"), ctx("c"))]);
    expect(r).toEqual({ ok: true, after: "a\r\nB\r\nc\r\n" });
  });

  it("keeps LF files byte-identical (no CRLF regression)", () => {
    const r = applyUpdate("a\nb\nc\n", [hunk(ctx("a"), del("b"), add("B"), ctx("c"))]);
    expect(r).toEqual({ ok: true, after: "a\nB\nc\n" });
  });

  it("preserves a CRLF file without a trailing newline", () => {
    const r = applyUpdate("a\r\nb", [hunk(ctx("a"), del("b"), add("B"))]);
    expect(r).toEqual({ ok: true, after: "a\r\nB" });
  });

  it("emits consistent CRLF when the hunk is located via the fuzzy whitespace ladder", () => {
    // File context "   a" carries extra indentation the hunk ("a") lacks — matched via the trim
    // rung, and the added line must still come out CRLF.
    const r = applyUpdate("   a\r\nb\r\n", [hunk(ctx("a"), del("b"), add("Z"))]);
    expect(r).toEqual({ ok: true, after: "   a\r\nZ\r\n" });
  });
});
