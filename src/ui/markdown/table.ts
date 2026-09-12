import stringWidth from "string-width";
import type { Span } from "./types";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** User-perceived characters. Keeping emoji ZWJ sequences and combining marks intact is
 * essential when truncating or hard-wrapping terminal text. */
export function graphemes(s: string): string[] {
  return Array.from(graphemeSegmenter.segment(s), ({ segment }) => segment);
}

/** Terminal display width using the same Unicode-aware implementation as Ink. Handles CJK,
 * combining marks, variation selectors, and multi-code-point emoji. */
export function displayWidth(s: string): number {
  return stringWidth(s);
}

const tableEmojiFallbacks: Readonly<Record<string, string>> = {
  "✅": "✓",
  "❌": "✗",
  "⚠": "!",
  "⛔": "!",
  "⚙": "*",
  "⏸": "‖",
};

/**
 * Emoji cursor widths differ between terminal emulators (notably Apple Terminal)
 * and Unicode-width libraries. In a bordered grid, one disagreement shifts every
 * following separator. Use stable text glyphs inside grid cells while leaving
 * emoji untouched everywhere else in Markdown.
 */
export function stableTableText(text: string): string {
  return graphemes(text)
    .map((grapheme) => {
      const base = grapheme.replaceAll("\uFE0F", "");
      const fallback = tableEmojiFallbacks[base];
      if (fallback) return fallback;
      return /\p{Extended_Pictographic}/u.test(grapheme) ? "*" : grapheme;
    })
    .join("");
}

export function stableTableSpans(spans: Span[]): Span[] {
  return spans.map((span) => ({ ...span, text: stableTableText(span.text) }));
}

/** Truncate `s` to a display width, appending "…" (width 1) when cut. */
export function truncateToWidth(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  if (width <= 1) return "…";
  let out = "";
  let w = 0;
  for (const grapheme of graphemes(s)) {
    const cw = displayWidth(grapheme);
    if (w + cw > width - 1) break;
    out += grapheme;
    w += cw;
  }
  return `${out}…`;
}

const cellWidth = (spans: Span[]): number => displayWidth(spans.map((s) => s.text).join(""));

export interface TableLayout {
  widths: number[];
}

/**
 * Leave the terminal's final column unused. Writing into that column can trigger
 * terminal auto-wrap, which moves a table's closing border onto the next line
 * even though its measured display width exactly matches `stdout.columns`.
 */
export function tableAvailableWidth(termWidth: number): number {
  return Math.max(1, termWidth - 1);
}

/**
 * Compute per-column natural (max-content) display widths for a table: the max
 * cell width across the header and all rows. Ragged rows are tolerated (missing
 * cells contribute nothing); the column count follows the header.
 */
export function layoutTable(headers: Span[][], rows: Span[][][]): TableLayout {
  const widths = headers.map((h) => cellWidth(h));
  for (const row of rows) {
    for (let i = 0; i < widths.length; i++) {
      const c = row[i];
      if (!c) continue;
      widths[i] = Math.max(widths[i]!, cellWidth(c));
    }
  }
  return { widths };
}

/** Minimum display width a column may be shrunk to when fitting the terminal. */
export const MIN_COL_WIDTH = 6;

/**
 * Fit natural column widths into the available terminal width. `sepWidth` is the
 * display width of one inter-column separator; `outerPad` is any fixed overhead
 * outside the gaps (e.g. a box table's outer "│ " and " │"). Total reserved
 * non-content width is `sepWidth * (n - 1) + outerPad`. Columns are shrunk widest
 * first, never below MIN_COL_WIDTH.
 */
export function fitColumns(
  natural: number[],
  termWidth: number,
  sepWidth: number,
  outerPad = 0,
): number[] {
  const n = natural.length;
  if (n === 0) return [];
  const sepTotal = sepWidth * (n - 1) + outerPad;
  const budget = Math.max(n * MIN_COL_WIDTH, termWidth - sepTotal);
  const widths = [...natural];
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let widest = 0;
    for (let i = 1; i < n; i++) {
      if (widths[i]! > widths[widest]!) widest = i;
    }
    if (widths[widest]! <= MIN_COL_WIDTH) break;
    widths[widest]!--;
    total--;
  }
  return widths;
}

/**
 * Non-content columns consumed by a box table of `n` columns: one space of
 * padding on each side of every cell (2n) plus the vertical bars (n + 1).
 * Equals `3 * (n - 1) + 4` for n ≥ 1 — the `sepWidth=3, outerPad=4` fitColumns args.
 */
export function frameOverhead(n: number): number {
  return n <= 0 ? 0 : 3 * n + 1;
}

const seg = (w: number): string => "─".repeat(w + 2);

/** Top box border: ┌─…─┬─…─┐ */
export function topBorder(widths: number[]): string {
  return `┌${widths.map(seg).join("┬")}┐`;
}

/** Header/body divider: ├─…─┼─…─┤ */
export function midBorder(widths: number[]): string {
  return `├${widths.map(seg).join("┼")}┤`;
}

/** Bottom box border: └─…─┴─…─┘ */
export function bottomBorder(widths: number[]): string {
  return `└${widths.map(seg).join("┴")}┘`;
}

/**
 * True when a box grid of `n` columns cannot fit even with every column shrunk
 * to MIN_COL_WIDTH. Only the column count matters — the minimum table width is
 * `n * MIN_COL_WIDTH + frameOverhead(n)`.
 */
export function shouldStack(n: number, termWidth: number): boolean {
  if (n <= 0) return false;
  return termWidth < n * MIN_COL_WIDTH + frameOverhead(n);
}
