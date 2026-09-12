/** Mid-stream degenerate-repetition detection (WS3.4). Pure. */

/** Minimum total chars the repeated region must span before firing (units of 3+ chars).
 *  Separates real degeneration (hundreds of chars and still going) from legitimate short
 *  repetition — markdown rules, table borders, and indentation runs all top out well
 *  below this. */
export const REPETITION_MIN_SPAN = 300;

/** Span floor for PRIMITIVE units of 1–2 chars. Legitimate ≥300-char runs are
 *  overwhelmingly single- or double-char units (padding, `====` banners, fixture strings
 *  in generated code), so they get a much higher bar; genuine 1–2-char degeneration still
 *  trips within the 2KB tail — later than 3+-char loops, but instant next to the 600s
 *  ceiling. */
export const REPETITION_MIN_SPAN_SHORT_UNIT = 1024;

/** Longest repeating unit considered, in chars (covers whole repeated lines). */
export const REPETITION_MAX_UNIT = 64;

/** How much stream tail a caller should retain per channel for detection. */
export const REPETITION_TAIL_CHARS = 2048;

/** Callers throttle detection to every this-many new chars per channel. */
export const REPETITION_CHECK_INTERVAL = 64;

/** True when `unit` is an exact repetition of a shorter unit ("===" of "=", "1.1." of
 *  "1."). Composite units are skipped in the scan: their primitive period was already
 *  evaluated at a shorter p with at least as many repeats, so letting a composite qualify
 *  would launder a 1–2-char run past REPETITION_MIN_SPAN_SHORT_UNIT via the lower floor
 *  (a 400-char `=` run reads as "===" × 133 at period 3). */
function isComposite(unit: string): boolean {
  const p = unit.length;
  for (let d = 1; d * 2 <= p; d++) {
    if (p % d !== 0) continue;
    if (unit === unit.slice(0, d).repeat(p / d)) return true;
  }
  return false;
}

/**
 * Detect degenerate repetition at the END of `tail`: a primitive unit of
 * 1–REPETITION_MAX_UNIT chars repeated `minRepeats`+ consecutive times whose total span
 * is ≥ REPETITION_MIN_SPAN chars (≥ REPETITION_MIN_SPAN_SHORT_UNIT for 1–2-char units).
 * End-anchored on purpose — degeneration continues to the stream's end by definition, so
 * a loop followed by fresh prose never fires (and the suffix walk is what keeps this
 * cheap: O(REPETITION_MAX_UNIT × span), no backtracking regex). Both floors are required:
 * count alone false-positives on an 80-char divider; span alone on a twice-repeated
 * paragraph. Returns the shortest qualifying unit, or null. `minRepeats <= 0` disables.
 */
export function detectRepetition(
  tail: string,
  minRepeats: number,
): { unit: string; repeats: number } | null {
  if (minRepeats <= 0) return null;
  const n = tail.length;
  if (n < REPETITION_MIN_SPAN) return null;
  for (let p = 1; p <= REPETITION_MAX_UNIT; p++) {
    // Even `minRepeats` copies of this unit no longer fit — larger units can't either.
    if (p * minRepeats > n) break;
    const unit = tail.slice(n - p);
    if (isComposite(unit)) continue;
    let repeats = 1;
    while ((repeats + 1) * p <= n && tail.startsWith(unit, n - (repeats + 1) * p)) repeats++;
    const minSpan = p <= 2 ? REPETITION_MIN_SPAN_SHORT_UNIT : REPETITION_MIN_SPAN;
    if (repeats >= minRepeats && repeats * p >= minSpan) return { unit, repeats };
  }
  return null;
}

/** Minimum normalized-line length considered for reasoning-loop detection. Shorter lines
 *  (markers like "-", "Next.") never count toward a loop. */
export const REASONING_LOOP_MIN_LINE = 20;

/** Cap on distinct normalized lines tracked per call — bounds memory on high-entropy
 *  reasoning. Once reached, NEW lines are not tracked (existing counts still increment); a
 *  degenerate loop is a tiny key set, so the cap never blocks detection. */
export const REASONING_LOOP_MAX_DISTINCT = 2048;

/** Cap on the unterminated-line buffer (`pending`). A stream that never emits `\n` would
 *  otherwise grow this without bound; once it exceeds the cap, it is discarded — a single
 *  line this long is not a repeating rumination unit (those are short, ≥20-char lines
 *  recurring many times), so dropping it costs no real detection. */
export const REASONING_LOOP_MAX_PENDING = 16384;

/** Exact long-cycle detection complements the short-unit suffix scan and the deliberately
 * opt-in repeated-line heuristic. Coding-model runaway loops commonly repeat a whole planning
 * paragraph several kilobytes long; requiring three byte-identical consecutive cycles makes
 * this safe enough to enable by default without treating ordinary recurring phrases as loops. */
export const REASONING_CYCLE_MIN_PERIOD = 256;
export const REASONING_CYCLE_MAX_PERIOD = 8192;
export const REASONING_CYCLE_ANCHOR = 128;
export const REASONING_CYCLE_CHECK_INTERVAL = 256;

export class ReasoningCycleDetector {
  private buffer = "";
  private pending = 0;

  constructor(private readonly repeats: number) {}

  reset(): void {
    this.buffer = "";
    this.pending = 0;
  }

  /** Returns true when the reasoning suffix contains `repeats` consecutive, byte-identical
   * cycles between 256 and 8192 chars. An exact 128-char suffix anchor cheaply identifies
   * candidate periods, avoiding an expensive scan across every possible block size. */
  push(text: string): boolean {
    if (this.repeats <= 0) return false;
    const requiredRepeats = Math.max(2, this.repeats);
    const maxBuffer = REASONING_CYCLE_MAX_PERIOD * requiredRepeats;
    this.buffer = (this.buffer + text).slice(-maxBuffer);
    this.pending += text.length;
    if (this.pending < REASONING_CYCLE_CHECK_INTERVAL) return false;
    this.pending = 0;

    const n = this.buffer.length;
    if (n < REASONING_CYCLE_MIN_PERIOD * requiredRepeats) return false;
    const anchorStart = n - REASONING_CYCLE_ANCHOR;
    const anchor = this.buffer.slice(anchorStart);
    let prior = this.buffer.lastIndexOf(anchor, anchorStart - 1);
    let candidates = 0;
    while (prior >= 0 && candidates < 64) {
      const period = anchorStart - prior;
      if (period > REASONING_CYCLE_MAX_PERIOD) break;
      if (period >= REASONING_CYCLE_MIN_PERIOD && n >= period * requiredRepeats) {
        const cycle = this.buffer.slice(n - period);
        let exact = true;
        for (let copy = 2; copy <= requiredRepeats; copy++) {
          const start = n - copy * period;
          if (this.buffer.slice(start, start + period) !== cycle) {
            exact = false;
            break;
          }
        }
        if (exact) return true;
      }
      candidates++;
      prior = this.buffer.lastIndexOf(anchor, prior - 1);
    }
    return false;
  }
}

/** Stateful, per-model-call detector for degenerate REASONING loops: the same normalized line
 *  recurring `threshold` times, even NON-consecutively (the ct12 shape — a sentence repeated
 *  hundreds of times scattered across long rumination, which the end-anchored `detectRepetition`
 *  misses). Feed reasoning deltas via `push`; it buffers partial lines across deltas and only
 *  counts newline-completed lines. One instance per model call. */
export class ReasoningLoopDetector {
  private readonly counts = new Map<string, number>();
  private pending = "";
  constructor(private readonly threshold: number) {}

  /** Returns true the FIRST time any normalized line reaches `threshold` occurrences.
   *  `threshold <= 0` disables (always false, no work). */
  push(text: string): boolean {
    if (this.threshold <= 0) return false;
    this.pending += text;
    let nl = this.pending.indexOf("\n");
    while (nl !== -1) {
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      if (this.record(line)) return true;
      nl = this.pending.indexOf("\n");
    }
    if (this.pending.length > REASONING_LOOP_MAX_PENDING) this.pending = "";
    return false;
  }

  private record(rawLine: string): boolean {
    const line = rawLine.trim().replace(/\s+/g, " ");
    if (line.length < REASONING_LOOP_MIN_LINE) return false;
    const prev = this.counts.get(line);
    if (prev === undefined) {
      if (this.counts.size >= REASONING_LOOP_MAX_DISTINCT) return false;
      this.counts.set(line, 1);
      return 1 >= this.threshold;
    }
    const next = prev + 1;
    this.counts.set(line, next);
    return next >= this.threshold;
  }
}
