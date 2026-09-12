export type DiffOp = { op: "eq" | "add" | "del"; text: string };

/**
 * Line-level diff via longest-common-subsequence. Splits both inputs on "\n",
 * computes the LCS of the line arrays, then walks both to emit ops in order:
 * `eq` for shared lines, `del` for lines only in `before`, `add` for lines only
 * in `after`. Deterministic and pure.
 */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: "eq", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ op: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ op: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ op: "del", text: a[i++]! });
  while (j < m) ops.push({ op: "add", text: b[j++]! });
  return ops;
}
