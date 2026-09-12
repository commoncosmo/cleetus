/** Render the changed span of a single-file edit as a numbered excerpt for the tool result, so
 *  the model sees the post-edit state without issuing a fresh read. Finds the first and last
 *  differing lines, includes `context` lines on each side, and returns null when that span would
 *  exceed `maxLines` (or when nothing changed) — the caller then falls back to a short note. Pure. */
export function changedRegion(
  before: string,
  after: string,
  context = 3,
  maxLines = 80,
): string | null {
  const a = after.split("\n");
  const b = before.split("\n");
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ai = a.length - 1;
  let bi = b.length - 1;
  while (ai >= lo && bi >= lo && a[ai] === b[bi]) {
    ai--;
    bi--;
  }
  if (ai < lo && bi < lo) return null; // no net change in the after-file's line range
  const start = Math.max(0, lo - context);
  const end = Math.min(a.length - 1, ai + context);
  if (end - start + 1 > maxLines) return null;
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`${i + 1}\t${a[i]}`);
  if (out.length === 0) return null;
  return out.join("\n");
}

/** Append the changed region (or a short fallback note) to an edit tool's summary line. */
export function appendRegion(base: string, before: string, after: string): string {
  const region = changedRegion(before, after);
  return region
    ? `${base}\n${region}`
    : `${base}\n(changed region spans too many lines to inline — re-read the file to view it)`;
}
