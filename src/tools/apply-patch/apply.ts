import { dominantEol } from "../eol";
import { nearMissHint } from "../near-miss";
import type { PatchHunk } from "./parse";

export type ApplyResult = { ok: true; after: string } | { ok: false; reason: string };

/** Locate `needle` as a contiguous run in `hay` starting at/after `from`. Tries an exact match,
 *  then ignoring trailing whitespace, then ignoring surrounding whitespace. Each rung restarts the
 *  scan at `from`, so an exact match anywhere at/after the cursor beats a fuzzy match earlier in
 *  the range. Returns the start index or -1. */
function findRun(hay: string[], needle: string[], from: number): number {
  if (needle.length === 0) return -1; // caller already guards empty oldBlock; defensive here
  const eqs: ((a: string, b: string) => boolean)[] = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
  ];
  for (const eq of eqs) {
    for (let i = from; i + needle.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (!eq(hay[i + j]!, needle[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return -1;
}

/** Apply context hunks to `content`. Hunks apply in order, each located at/after the previous
 *  match. Context lines are emitted from the FILE's actual text (preserving its whitespace even on
 *  a fuzzy match), del lines dropped, add lines inserted. Atomic: any hunk that can't be located
 *  returns a reason with no partial result. */
export function applyUpdate(content: string, hunks: PatchHunk[]): ApplyResult {
  // Line endings are preserved: split on /\r?\n/ (clean lines) and rejoin on the file's dominant
  // EOL, so a CRLF file stays all-CRLF and added lines match the file's endings.
  const eol = dominantEol(content);
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop(); // drop the empty element after the final newline

  let cursor = 0;
  for (let h = 0; h < hunks.length; h++) {
    const ops = hunks[h]!.lines;
    // The block to find = context + del lines (everything except pure additions).
    const oldBlock = ops.filter((o) => o.kind !== "add").map((o) => o.text);
    if (oldBlock.length === 0) {
      return { ok: false, reason: `hunk ${h + 1} has no context to locate the insertion` };
    }
    const at = findRun(lines, oldBlock, cursor);
    if (at === -1) {
      let reason = `hunk ${h + 1} could not be located in the file (context did not match)`;
      const hint = nearMissHint(content, oldBlock.join("\n"));
      if (hint) reason = `${reason}\n\n${hint}`;
      return { ok: false, reason };
    }
    // Build the replacement, consuming matched file lines for context/del.
    const replacement: string[] = [];
    let fp = at;
    for (const o of ops) {
      if (o.kind === "context") {
        replacement.push(lines[fp]!); // preserve the file's actual line
        fp++;
      } else if (o.kind === "del") {
        fp++; // consume, emit nothing
      } else {
        replacement.push(o.text.replace(/\r$/, "")); // add — strip any CR so join re-terminates
      }
    }
    lines.splice(at, oldBlock.length, ...replacement);
    cursor = at + replacement.length;
  }

  let after = lines.join(eol);
  if (hadTrailingNewline) after += eol;
  return { ok: true, after };
}
