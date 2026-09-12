const MAX_REGION_LINES = 12;
const FUZZY_THRESHOLD = 0.5;

/** Adjacent-character bigrams of a string. */
function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice coefficient over character bigrams. 1 = identical, 0 = disjoint. */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  const counts = new Map<string, number>();
  for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
  let inter = 0;
  for (const g of bb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      inter++;
      counts.set(g, c - 1);
    }
  }
  return (2 * inter) / (ba.length + bb.length);
}

/** Render file lines [start..end] (0-based inclusive), capped with a count note. */
function renderRegion(lines: string[], start: number, end: number): string {
  const slice = lines.slice(start, end + 1);
  if (slice.length <= MAX_REGION_LINES) return slice.join("\n");
  const shown = slice.slice(0, MAX_REGION_LINES).join("\n");
  return `${shown}\n…${slice.length - MAX_REGION_LINES} more lines`;
}

/**
 * Given a file and a search block that failed to locate, return a near-miss hint:
 * a whitespace-only diagnosis with the file's verbatim region (copy-pasteable), or
 * the closest fuzzy region, or null when nothing in the file is a decent match.
 * Pure; never throws on ordinary string input.
 */
export function nearMissHint(fileText: string, searchText: string): string | null {
  if (searchText.length === 0 || fileText.length === 0) return null;
  const fileLines = fileText.split("\n");
  const searchLines = searchText.split("\n");
  const h = searchLines.length;
  const normFile = fileLines.map((l) => l.trim());
  const normSearch = searchLines.map((l) => l.trim());

  // 1. Whitespace-normalized contiguous match. Skip when the search block is all
  // whitespace (every trimmed line empty) — it would spuriously match any blank file
  // line; fall through to the fuzzy branch (which returns null with no anchor).
  if (normSearch.some((l) => l.length > 0)) {
    for (let i = 0; i + h <= normFile.length; i++) {
      let match = true;
      for (let j = 0; j < h; j++) {
        if (normFile[i + j] !== normSearch[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const region = renderRegion(fileLines, i, i + h - 1);
        return `Found a whitespace-only difference at lines ${i + 1}–${i + h}. Your old_text's indentation doesn't match the file. The file's exact text there is:\n\`\`\`\n${region}\n\`\`\``;
      }
    }
  }

  // 2. Fuzzy fallback: anchor on the most distinctive (longest non-blank) search line.
  const anchor = [...normSearch].filter((l) => l.length > 0).sort((a, b) => b.length - a.length)[0];
  if (!anchor) return null;
  let bestScore = 0;
  let bestLine = -1;
  for (let i = 0; i < normFile.length; i++) {
    const s = dice(anchor, normFile[i]!);
    if (s > bestScore) {
      bestScore = s;
      bestLine = i;
    }
  }
  if (bestLine === -1 || bestScore < FUZZY_THRESHOLD) return null;
  const start = Math.max(0, bestLine - Math.floor((h - 1) / 2));
  const end = Math.min(fileLines.length - 1, start + h - 1);
  const region = renderRegion(fileLines, start, end);
  return `Closest match in the file (lines ${start + 1}–${end + 1}) — check for differences:\n\`\`\`\n${region}\n\`\`\``;
}
