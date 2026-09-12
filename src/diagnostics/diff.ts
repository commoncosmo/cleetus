import type { Diagnostic } from "./types";

/** Identity key for a diagnostic, deliberately excluding line/col so a pre-existing
 *  error whose line shifts after an edit is not mistaken for a new one. */
export function fingerprint(d: Diagnostic): string {
  return `${d.file}│${d.severity}│${d.code ?? ""}│${d.message}`;
}

/** Count occurrences of each fingerprint. */
export function toMultiset(diags: Diagnostic[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of diags) {
    const k = fingerprint(d);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Diagnostics in `current` beyond what the baseline multiset already accounts for. */
export function computeNew(baseline: Map<string, number>, current: Diagnostic[]): Diagnostic[] {
  const remaining = new Map(baseline);
  const fresh: Diagnostic[] = [];
  for (const d of current) {
    const k = fingerprint(d);
    const c = remaining.get(k) ?? 0;
    if (c > 0) remaining.set(k, c - 1);
    else fresh.push(d);
  }
  return fresh;
}

/** How many baseline diagnostics are no longer present in `current`. */
export function countFixed(baseline: Map<string, number>, current: Diagnostic[]): number {
  const cur = toMultiset(current);
  let fixed = 0;
  for (const [k, bc] of baseline) {
    const cc = cur.get(k) ?? 0;
    if (bc > cc) fixed += bc - cc;
  }
  return fixed;
}
