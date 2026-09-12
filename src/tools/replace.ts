import { dominantEol } from "./eol";

export interface Replacement {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export type ReplaceResult =
  | { ok: true; text: string; count: number; whitespaceTolerant?: boolean }
  | { ok: false; reason: string; code: "empty" | "not_found" | "multiple" | "multiple_ws" };

/** Leading-whitespace prefix of a line (spaces/tabs before the first non-space char). */
function leadingWhitespace(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/** Drop fully-blank lines from both ends of a line array, keeping interior blanks. A leading or
 *  trailing blank line in an edit pattern carries no match information — most often it is a stray
 *  newline the model appended — yet the line-count-exact tolerant matcher would otherwise demand a
 *  blank file line there and fail a legitimate edit. Pure. */
function trimBlankEnds(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * Re-indent `newText` from the model's base indentation (`oldBase`) to the file's actual base
 * indentation (`fileBase`). Each line that starts with `oldBase` is shifted by swapping that
 * prefix for `fileBase`, which preserves relative nesting; whitespace-only lines become empty
 * (no trailing whitespace); lines less-indented than the anchor are left as-is (best-effort).
 * Pure.
 */
export function reindent(newText: string, oldBase: string, fileBase: string): string {
  return newText
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return "";
      if (line.startsWith(oldBase)) return fileBase + line.slice(oldBase.length);
      return line;
    })
    .join("\n");
}

/**
 * Fallback locator used only when the exact substring match found nothing: match `oldText`
 * against the file line-by-line ignoring each line's surrounding whitespace. On a unique run
 * (or every run under `replaceAll`), replace it with `newText` re-indented to the file's actual
 * indentation. An all-blank block is never located this way (it would match any blank run). Pure.
 */
function whitespaceTolerantReplace(text: string, edit: Replacement): ReplaceResult {
  const eol = dominantEol(text);
  const fileLines = text.split(/\r?\n/);
  // Match on the pattern's non-blank core: blank lines at either end carry no information and a
  // stray trailing newline would otherwise force a phantom blank-line match against the following
  // file line (the py1 forensic failure). new_text is trimmed the same way so line counts stay
  // balanced and no stray blank line is spliced in.
  const oldLines = trimBlankEnds(edit.oldText.split(/\r?\n/));
  const h = oldLines.length;
  const oldTrim = oldLines.map((l) => l.trim());
  const anchorIdx = oldTrim.findIndex((l) => l.length > 0);
  if (anchorIdx === -1) return { ok: false, reason: "old_text not found", code: "not_found" };

  const starts: number[] = [];
  for (let i = 0; i + h <= fileLines.length; i++) {
    let match = true;
    for (let j = 0; j < h; j++) {
      if (fileLines[i + j]!.trim() !== oldTrim[j]) {
        match = false;
        break;
      }
    }
    if (match) starts.push(i);
  }
  if (starts.length === 0) return { ok: false, reason: "old_text not found", code: "not_found" };
  if (starts.length > 1 && !edit.replaceAll) {
    return {
      ok: false,
      reason: `old_text matches ${starts.length} places ignoring indentation; add more context or pass replace_all`,
      code: "multiple_ws",
    };
  }

  const oldBase = leadingWhitespace(oldLines[anchorIdx]!);
  const newCore = trimBlankEnds(edit.newText.split(/\r?\n/)).join("\n");
  const out = [...fileLines];
  // Splice bottom-to-top so earlier (lower-index) match positions stay valid as lengths change.
  for (const start of [...starts].reverse()) {
    const fileBase = leadingWhitespace(fileLines[start + anchorIdx]!);
    const replacement = reindent(newCore, oldBase, fileBase).split(/\r?\n/);
    out.splice(start, h, ...replacement);
  }
  return { ok: true, text: out.join(eol), count: starts.length, whitespaceTolerant: true };
}

/**
 * Apply one literal search/replace to `text`. Pure; no I/O. Shared by `edit_file`
 * and `multi_edit` so their match/replace semantics never drift. The replacement is
 * literal — `$&`, `$1`, `` $` `` in `newText` are inserted verbatim, not interpreted.
 *
 * Tier 1 is an exact substring match (also handles mid-line/substring edits). Only when that
 * finds nothing does Tier 2 (`whitespaceTolerantReplace`) retry line-by-line ignoring indentation.
 */
export function applyReplacement(text: string, edit: Replacement): ReplaceResult {
  if (edit.oldText === "")
    return { ok: false, reason: "old_text must not be empty", code: "empty" };
  const occurrences = text.split(edit.oldText).length - 1;
  if (occurrences === 0) return whitespaceTolerantReplace(text, edit);
  if (occurrences > 1 && !edit.replaceAll) {
    return {
      ok: false,
      reason: `old_text matches ${occurrences} times; pass replace_all`,
      code: "multiple",
    };
  }
  const next = edit.replaceAll
    ? text.split(edit.oldText).join(edit.newText)
    : text.replace(edit.oldText, () => edit.newText);
  return { ok: true, text: next, count: edit.replaceAll ? occurrences : 1 };
}
