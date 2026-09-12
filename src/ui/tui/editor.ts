/** A single-cursor text buffer that may span multiple lines (`\n`-separated). */
export interface Buffer {
  text: string;
  /** Cursor offset into `text`, 0..text.length. */
  cursor: number;
}

export const EMPTY: Buffer = { text: "", cursor: 0 };

export function fromText(text: string): Buffer {
  return { text, cursor: text.length };
}

export function insert(buf: Buffer, str: string): Buffer {
  const text = buf.text.slice(0, buf.cursor) + str + buf.text.slice(buf.cursor);
  return { text, cursor: buf.cursor + str.length };
}

const ESC = String.fromCharCode(27);

/**
 * Keep pasted structure (line breaks and indentation) while removing terminal
 * framing/control bytes that must not become prompt text.
 */
export function normalizeInput(text: string): string {
  let unframed = text;
  for (const opening of [`${ESC}[200~`, "[200~"]) {
    if (unframed.startsWith(opening)) unframed = unframed.slice(opening.length);
  }
  for (const closing of [`${ESC}[201~`, "[201~"]) {
    if (unframed.endsWith(closing)) unframed = unframed.slice(0, -closing.length);
  }
  const withoutPasteFraming = unframed.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let out = "";
  for (const ch of withoutPasteFraming) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\n" || ch === "\t" || (cp >= 0x20 && cp !== 0x7f)) out += ch;
  }
  return out;
}

/** Delete the character before the cursor (Backspace); merges lines at a line start. */
export function backspace(buf: Buffer): Buffer {
  if (buf.cursor === 0) return buf;
  const text = buf.text.slice(0, buf.cursor - 1) + buf.text.slice(buf.cursor);
  return { text, cursor: buf.cursor - 1 };
}

export function left(buf: Buffer): Buffer {
  return buf.cursor === 0 ? buf : { ...buf, cursor: buf.cursor - 1 };
}

export function right(buf: Buffer): Buffer {
  return buf.cursor >= buf.text.length ? buf : { ...buf, cursor: buf.cursor + 1 };
}

export function isMultiline(buf: Buffer): boolean {
  return buf.text.includes("\n");
}

function rowOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function position(buf: Buffer): { row: number; col: number } {
  const before = buf.text.slice(0, buf.cursor);
  const nl = before.lastIndexOf("\n");
  const row = before.length === 0 ? 0 : (before.match(/\n/g)?.length ?? 0);
  return { row, col: buf.cursor - (nl + 1) };
}

/** Move the cursor to the same column on the previous line (or to the start on line 0). */
export function up(buf: Buffer): Buffer {
  const { row, col } = position(buf);
  if (row === 0) return { ...buf, cursor: 0 };
  const lines = buf.text.split("\n");
  const offsets = rowOffsets(buf.text);
  return { ...buf, cursor: offsets[row - 1]! + Math.min(col, lines[row - 1]!.length) };
}

/** Move the cursor to the same column on the next line (or to the end on the last line). */
export function down(buf: Buffer): Buffer {
  const { row, col } = position(buf);
  const lines = buf.text.split("\n");
  if (row >= lines.length - 1) return { ...buf, cursor: buf.text.length };
  const offsets = rowOffsets(buf.text);
  return { ...buf, cursor: offsets[row + 1]! + Math.min(col, lines[row + 1]!.length) };
}

export interface VisualLayout {
  /** Visual rows after wrapping each logical line to `width` columns. */
  rows: string[];
  cursorRow: number;
  cursorCol: number;
}

interface VisualRow {
  text: string;
  /** Source columns covered by this row. `end` may include hidden wrap whitespace. */
  start: number;
  end: number;
}

function wrappedRows(line: string, width: number): VisualRow[] {
  if (line.length === 0) return [{ text: "", start: 0, end: 0 }];
  const rows: VisualRow[] = [];
  let start = 0;
  while (start < line.length) {
    if (line.length - start <= width) {
      rows.push({ text: line.slice(start), start, end: line.length });
      break;
    }

    const max = start + width;
    let whitespaceStart = -1;
    let whitespaceEnd = -1;

    if (/\s/.test(line[max]!)) {
      whitespaceStart = max;
      whitespaceEnd = max;
    } else if (/\s/.test(line[max - 1]!)) {
      whitespaceStart = max - 1;
      while (whitespaceStart > start && /\s/.test(line[whitespaceStart - 1]!)) {
        whitespaceStart--;
      }
      whitespaceEnd = max;
    } else {
      for (let i = max - 1; i > start; i--) {
        if (/\s/.test(line[i]!)) {
          whitespaceStart = i;
          whitespaceEnd = i + 1;
          while (whitespaceStart > start && /\s/.test(line[whitespaceStart - 1]!)) {
            whitespaceStart--;
          }
          break;
        }
      }
    }

    // Do not emit an empty row for leading indentation before a long word.
    const hasContentBeforeWhitespace =
      whitespaceStart > start && /\S/.test(line.slice(start, whitespaceStart));
    if (hasContentBeforeWhitespace) {
      while (whitespaceEnd < line.length && /\s/.test(line[whitespaceEnd]!)) whitespaceEnd++;
      rows.push({
        text: line.slice(start, whitespaceStart),
        start,
        end: whitespaceEnd,
      });
      start = whitespaceEnd;
    } else {
      rows.push({ text: line.slice(start, max), start, end: max });
      start = max;
    }
  }
  return rows;
}

/**
 * Wrap each logical (`\n`-separated) line to `width` columns and locate the
 * cursor among the resulting visual rows. Unlike `layout`, this accounts for
 * terminal-width wrapping so the cursor lands on the correct visual row.
 */
export function visualLayout(buf: Buffer, width: number): VisualLayout {
  const w = Math.max(1, Math.floor(width));
  const { row: logRow, col } = position(buf);
  const lines = buf.text.split("\n");
  const rows: string[] = [];
  let cursorRow = 0;
  let cursorCol = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const visualRows = wrappedRows(line, w);
    const rowsInLine = visualRows.length;
    const base = rows.length;
    rows.push(...visualRows.map((r) => r.text));
    if (li === logRow) {
      // A cursor after whitespace consumed at a soft-wrap boundary belongs at
      // the start of the continuation row. A cursor inside that whitespace
      // remains at the visible end of the preceding row.
      let vr = visualRows.findIndex((r, i) => col < r.end || i === rowsInLine - 1);
      if (vr < 0) vr = rowsInLine - 1;
      const row = visualRows[vr]!;
      cursorRow = base + vr;
      cursorCol = Math.min(Math.max(0, col - row.start), row.text.length);
    }
  }
  return { rows, cursorRow, cursorCol };
}
