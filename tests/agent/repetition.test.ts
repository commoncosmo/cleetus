import { describe, expect, it } from "bun:test";
import {
  REASONING_LOOP_MAX_DISTINCT,
  REASONING_LOOP_MAX_PENDING,
  REASONING_LOOP_MIN_LINE,
  REPETITION_MIN_SPAN,
  REPETITION_MIN_SPAN_SHORT_UNIT,
  REPETITION_TAIL_CHARS,
  ReasoningCycleDetector,
  ReasoningLoopDetector,
  detectRepetition,
} from "../../src/agent/repetition";

describe("ReasoningCycleDetector", () => {
  const cycle = Array.from(
    { length: 72 },
    (_, i) => `state-slot-${String(i).padStart(3, "0")}: map this distinct handler and dependency`,
  ).join("\n");

  it("detects a multi-kilobyte exact planning cycle like the codex10 trace", () => {
    expect(cycle.length).toBeGreaterThan(3000);
    expect(cycle.length).toBeLessThan(8192);
    const detector = new ReasoningCycleDetector(3);
    let fired = false;
    const stream = cycle.repeat(4);
    for (let offset = 0; offset < stream.length; offset += 37) {
      fired = detector.push(stream.slice(offset, offset + 37)) || fired;
      if (fired) break;
    }
    expect(fired).toBe(true);
  });

  it("does not confuse recurring phrases inside changing reasoning with an exact cycle", () => {
    const detector = new ReasoningCycleDetector(3);
    let fired = false;
    for (let i = 0; i < 100; i++) {
      fired =
        detector.push(
          `Now I need to map the state carefully. Unique handler ${i} has dependency ${i * 17}.\n`,
        ) || fired;
    }
    expect(fired).toBe(false);
  });

  it("is disabled at zero and reset breaks cycle continuity", () => {
    const disabled = new ReasoningCycleDetector(0);
    expect(disabled.push(cycle.repeat(5))).toBe(false);
    const detector = new ReasoningCycleDetector(3);
    detector.push(cycle.repeat(2));
    detector.reset();
    expect(detector.push(cycle.repeat(2))).toBe(false);
  });
});

describe("detectRepetition", () => {
  it("detects a short-period loop past both floors and reports the shortest unit", () => {
    const hit = detectRepetition("we,".repeat(120), 12); // span 360 ≥ 300, repeats 120 ≥ 12
    expect(hit).not.toBeNull();
    expect(hit!.unit).toBe("we,");
    expect(hit!.repeats).toBe(120);
  });

  it("detects a whole repeated line as the unit", () => {
    const line = "I will now read the file again.\n"; // 32 chars
    const hit = detectRepetition(`some prose first\n${line.repeat(12)}`, 12); // span 384
    expect(hit).not.toBeNull();
    expect(hit!.unit).toBe(line);
    expect(hit!.repeats).toBe(12);
  });

  it("does NOT fire on a legitimate divider (span floor)", () => {
    expect(detectRepetition("=".repeat(80), 12)).toBeNull();
    expect(detectRepetition(`## Results\n${"=".repeat(80)}`, 12)).toBeNull();
    expect(detectRepetition("-|-".repeat(30), 12)).toBeNull(); // 90-char table border
  });

  it("does NOT fire below the repeat-count floor even over a huge span", () => {
    // 30-char unit with no internal period, repeated 11× = 330 chars: span passes, count fails.
    const unit = "abcdefghijklmnopqrstuvwxyz0123";
    expect(detectRepetition(unit.repeat(11), 12)).toBeNull();
    expect(detectRepetition(unit.repeat(12), 12)).not.toBeNull();
  });

  it("is end-anchored: a loop followed by fresh prose never fires", () => {
    const tail = `${"we,".repeat(120)}and then it recovered with fresh prose about the task.`;
    expect(detectRepetition(tail, 12)).toBeNull();
  });

  it("span boundary: exactly REPETITION_MIN_SPAN fires, one unit less does not", () => {
    const unit = "abc";
    const atFloor = unit.repeat(REPETITION_MIN_SPAN / unit.length); // exactly 300 chars
    expect(detectRepetition(atFloor, 12)).not.toBeNull();
    expect(detectRepetition(unit.repeat(REPETITION_MIN_SPAN / unit.length - 1), 12)).toBeNull();
  });

  it("handles multi-byte content, including surrogate pairs", () => {
    const hit = detectRepetition("héé,".repeat(100), 12); // 4 chars × 100 = 400
    expect(hit).not.toBeNull();
    expect(hit!.unit).toBe("héé,");
    const emoji = detectRepetition("🙂".repeat(600), 12); // 2 code units × 600 = 1200 ≥ 1024
    expect(emoji).not.toBeNull();
  });

  it("returns null for short tails, empty input, and minRepeats <= 0", () => {
    expect(detectRepetition("we,".repeat(5), 12)).toBeNull();
    expect(detectRepetition("", 12)).toBeNull();
    expect(detectRepetition("we,".repeat(200), 0)).toBeNull(); // disabled
  });

  it("does NOT fire on long legitimate 1-2 char runs below the short-unit floor", () => {
    // Realistic real-world sizes (a 400-char banner, a 200x "1." list) — literals are fine
    // here, but they must stay below REPETITION_MIN_SPAN_SHORT_UNIT (currently 1024).
    expect(detectRepetition("=".repeat(400), 12)).toBeNull(); // banner / fixture run
    expect(detectRepetition("1.".repeat(200), 12)).toBeNull(); // 400 chars, 2-char unit
  });

  it("composite units cannot launder a short run past the short-unit floor", () => {
    // A 400-char "=" run reads as "===" × 133 at period 3 (span 399 ≥ 300): the
    // composite skip must keep the period-1 floor (1024) governing.
    expect(detectRepetition("=".repeat(400), 13)).toBeNull();
  });

  it("fires on genuine 1-2 char degeneration once past the short-unit floor", () => {
    const one = detectRepetition("=".repeat(REPETITION_MIN_SPAN_SHORT_UNIT), 12);
    expect(one).not.toBeNull();
    expect(one!.unit).toBe("=");
    const two = detectRepetition("1.".repeat(REPETITION_MIN_SPAN_SHORT_UNIT / 2), 12); // exactly the floor
    expect(two).not.toBeNull();
    expect(two!.unit).toBe("1.");
    expect(detectRepetition("=".repeat(REPETITION_MIN_SPAN_SHORT_UNIT - 1), 12)).toBeNull();
  });

  it("tail cap invariant: the retained tail can always satisfy the short-unit floor", () => {
    expect(REPETITION_TAIL_CHARS).toBeGreaterThanOrEqual(REPETITION_MIN_SPAN_SHORT_UNIT);
  });

  it("REPETITION_MAX_UNIT boundary: a 64-char unit is considered, a 65-char unit is not", () => {
    const unit64 = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ!?"; // 64 chars, primitive
    expect(unit64.length).toBe(64);
    expect(detectRepetition(unit64.repeat(12), 12)).not.toBeNull(); // span 768 ≥ 300
    const unit65 = `${unit64}@`;
    expect(detectRepetition(unit65.repeat(12), 12)).toBeNull();
  });

  it("negative minRepeats disables like 0", () => {
    expect(detectRepetition("we,".repeat(200), -1)).toBeNull();
  });
});

describe("ReasoningLoopDetector", () => {
  const LINE = "Let me implement this now."; // 26 chars ≥ MIN_LINE

  it("fires when a line recurs threshold times, even non-consecutively", () => {
    const d = new ReasoningLoopDetector(12);
    let firedAt = -1;
    for (let i = 0; i < 20; i++) {
      // a unique filler line between each repeat (non-consecutive)
      d.push(`unique filler thought number ${i} here\n`);
      if (d.push(`${LINE}\n`)) {
        firedAt = i;
        break;
      }
    }
    expect(firedAt).toBe(11); // fires on the 12th occurrence (0-indexed i=11)
  });

  it("does NOT fire below threshold", () => {
    const d = new ReasoningLoopDetector(12);
    let fired = false;
    for (let i = 0; i < 11; i++) fired = d.push(`${LINE}\n`) || fired;
    expect(fired).toBe(false);
  });

  it("ignores short lines (< MIN_LINE) however often they repeat", () => {
    const d = new ReasoningLoopDetector(3);
    let fired = false;
    for (let i = 0; i < 50; i++) fired = d.push("Next.\n") || fired; // 5 chars
    expect(fired).toBe(false);
  });

  it("counts a line split across pushes once completed", () => {
    const d = new ReasoningLoopDetector(2);
    expect(d.push("Let me implement ")).toBe(false); // no newline yet — buffered
    expect(d.push("this now.\n")).toBe(false); // completes 1st occurrence
    expect(d.push(`${LINE}\n`)).toBe(true); // 2nd occurrence → fires
  });

  it("normalizes whitespace so spacing variants collapse to one key", () => {
    const d = new ReasoningLoopDetector(2);
    expect(d.push("Let me   implement this now.\n")).toBe(false);
    expect(d.push("  Let me implement this now.  \n")).toBe(true);
  });

  it("threshold 0 disables", () => {
    const d = new ReasoningLoopDetector(0);
    let fired = false;
    for (let i = 0; i < 50; i++) fired = d.push(`${LINE}\n`) || fired;
    expect(fired).toBe(false);
  });

  it("bounds distinct keys but still fires on an already-tracked line", () => {
    const d = new ReasoningLoopDetector(2);
    // First occurrence of LINE is tracked, then flood with unique long lines past the cap.
    d.push(`${LINE}\n`);
    for (let i = 0; i < 2100; i++) d.push(`distinct long reasoning line number ${i} xxxxx\n`);
    // LINE was tracked before the cap filled, so its 2nd occurrence still fires.
    expect(d.push(`${LINE}\n`)).toBe(true);
  });

  it("negative threshold disables like 0", () => {
    const d = new ReasoningLoopDetector(-1);
    let fired = false;
    for (let i = 0; i < 50; i++) fired = d.push(`${LINE}\n`) || fired;
    expect(fired).toBe(false);
  });

  it("a normalized line of exactly REASONING_LOOP_MIN_LINE chars counts (boundary)", () => {
    const exact = "a".repeat(REASONING_LOOP_MIN_LINE);
    expect(exact.length).toBe(REASONING_LOOP_MIN_LINE);
    const d = new ReasoningLoopDetector(2);
    expect(d.push(`${exact}\n`)).toBe(false);
    expect(d.push(`${exact}\n`)).toBe(true);
    // One char short of the floor never counts, however often it repeats.
    const short = "a".repeat(REASONING_LOOP_MIN_LINE - 1);
    const d2 = new ReasoningLoopDetector(2);
    expect(d2.push(`${short}\n`)).toBe(false);
    expect(d2.push(`${short}\n`)).toBe(false);
  });

  it("a brand-new line pushed after the distinct cap is full never fires", () => {
    const d = new ReasoningLoopDetector(2);
    // Fill the distinct-key cap with unique long lines, none repeated.
    for (let i = 0; i < REASONING_LOOP_MAX_DISTINCT; i++) {
      d.push(`distinct long reasoning line number ${i} xxxxx\n`);
    }
    // A line that has never been seen before, pushed after the cap is saturated, is not
    // tracked at all — so even repeating it never fires.
    let fired = false;
    for (let i = 0; i < 10; i++)
      fired = d.push("a brand new line never seen before now\n") || fired;
    expect(fired).toBe(false);
  });

  it("caps the unterminated pending buffer instead of growing it unboundedly", () => {
    const d = new ReasoningLoopDetector(2);
    // A stream that never emits a newline: push well past REASONING_LOOP_MAX_PENDING in one go.
    const chunk = "x".repeat(REASONING_LOOP_MAX_PENDING + 1000);
    expect(d.push(chunk)).toBe(false);
    // Internal pending buffer was reset rather than left to grow — verified indirectly: a
    // subsequent short, complete, repeated line still behaves normally (no corruption / no
    // spurious fire from the discarded fragment).
    expect(d.push(`${LINE}\n`)).toBe(false);
    expect(d.push(`${LINE}\n`)).toBe(true);
  });
});
