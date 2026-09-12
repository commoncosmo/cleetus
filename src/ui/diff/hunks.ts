import type { DiffOp } from "./lcs";

export interface Hunk {
  ops: DiffOp[];
}
export interface HunkResult {
  hunks: Hunk[];
  /** Changed (add/del) lines dropped by the line cap (0 if none). */
  truncated: number;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 200;

/**
 * Collapse a line diff to changed-only hunks: each hunk includes up to `context`
 * unchanged (eq) lines on either side of its changes; runs of eq longer than
 * 2*context between changes split hunks, and leading/trailing eq beyond context
 * is dropped. Emits at most `maxLines` op lines total; the count of changed
 * (add/del) lines not emitted is returned as `truncated`.
 */
export function toHunks(
  ops: DiffOp[],
  context = DEFAULT_CONTEXT,
  maxLines = DEFAULT_MAX_LINES,
): HunkResult {
  const changedIdx: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i]!.op !== "eq") changedIdx.push(i);
  if (changedIdx.length === 0) return { hunks: [], truncated: 0 };

  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changedIdx) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const hunks: Hunk[] = [];
  let emitted = 0;
  let truncated = 0;
  let capped = false;
  for (const { start, end } of ranges) {
    if (capped) {
      for (let i = start; i <= end; i++) if (ops[i]!.op !== "eq") truncated++;
      continue;
    }
    const hunkOps: DiffOp[] = [];
    for (let i = start; i <= end; i++) {
      if (emitted >= maxLines) {
        capped = true;
        if (ops[i]!.op !== "eq") truncated++;
        continue;
      }
      hunkOps.push(ops[i]!);
      emitted++;
    }
    if (hunkOps.length > 0) hunks.push({ ops: hunkOps });
  }
  return { hunks, truncated };
}
