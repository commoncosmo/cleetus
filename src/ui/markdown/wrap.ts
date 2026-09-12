import { displayWidth, graphemes } from "./table";
import type { Span } from "./types";

/**
 * Word-wrap styled spans to a maximum display width, preserving each span's
 * styling (bold/italic/code/color). Returns physical lines, each a Span[].
 * Whitespace runs collapse to a single space and are dropped at line starts.
 * A word wider than `width` is hard-broken. An empty or whitespace-only input
 * yields a single empty line (`[[]]`) so a row is always at least one line tall.
 */
export function wrapSpans(spans: Span[], width: number): Span[][] {
  const w = Math.max(1, width);
  const lines: Span[][] = [];
  let cur: Span[] = [];
  let curW = 0;

  const pushLine = () => {
    lines.push(cur);
    cur = [];
    curW = 0;
  };
  const addPiece = (text: string, style: Span) => {
    cur.push({ ...style, text });
    curW += displayWidth(text);
  };

  for (const span of spans) {
    const tokens = span.text.match(/\s+|\S+/g) ?? [];
    for (const tok of tokens) {
      if (/^\s+$/.test(tok)) {
        if (curW === 0) continue; // drop leading whitespace
        if (curW + 1 > w) pushLine();
        else addPiece(" ", span);
        continue;
      }
      const tw = displayWidth(tok);
      if (curW + tw <= w) {
        addPiece(tok, span);
        continue;
      }
      if (curW > 0) pushLine();
      if (tw > w) {
        let rest = tok;
        while (displayWidth(rest) > w) {
          let take = "";
          let tk = 0;
          for (const grapheme of graphemes(rest)) {
            const cw = displayWidth(grapheme);
            if (tk + cw > w) {
              if (tk === 0) take += grapheme; // always take at least one grapheme to make progress
              break;
            }
            take += grapheme;
            tk += cw;
          }
          addPiece(take, span);
          rest = rest.slice(take.length);
          if (displayWidth(rest) > 0 || rest.length > 0) pushLine();
        }
        if (rest.length > 0) addPiece(rest, span);
      } else {
        addPiece(tok, span);
      }
    }
  }
  pushLine(); // always flushes at least one line; empty input yields [[]]
  return lines;
}
