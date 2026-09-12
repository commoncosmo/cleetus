import { describe, expect, it } from "bun:test";
import { StreamWatchdogObjectSchema } from "../../src/config/schema";
import { DEFAULT_STREAM_WATCHDOG, resolveStreamWatchdog } from "../../src/config/stream-watchdog";

describe("resolveStreamWatchdog", () => {
  it("returns defaults when nothing is configured", () => {
    expect(resolveStreamWatchdog()).toEqual(DEFAULT_STREAM_WATCHDOG);
    expect(DEFAULT_STREAM_WATCHDOG).toEqual({
      enabled: true,
      firstTokenMs: 300000,
      noProgressMs: 180000,
      maxCallMs: 600000,
      repetitionRepeats: 12,
      reasoningLoopLines: 0,
      reasoningCycleRepeats: 3,
    });
  });

  it("applies project over global over default", () => {
    expect(resolveStreamWatchdog({ no_progress_ms: 60000 }, { no_progress_ms: 30000 })).toEqual({
      enabled: true,
      firstTokenMs: 300000,
      noProgressMs: 30000,
      maxCallMs: 600000,
      repetitionRepeats: 12,
      reasoningLoopLines: 0,
      reasoningCycleRepeats: 3,
    });
    expect(resolveStreamWatchdog({ enabled: false }, undefined)).toEqual({
      enabled: false,
      firstTokenMs: 300000,
      noProgressMs: 180000,
      maxCallMs: 600000,
      repetitionRepeats: 12,
      reasoningLoopLines: 0,
      reasoningCycleRepeats: 3,
    });
  });

  it("resolves max_call_ms with project over global over default", () => {
    expect(resolveStreamWatchdog({ max_call_ms: 200000 }, { max_call_ms: 100000 })).toEqual({
      enabled: true,
      firstTokenMs: 300000,
      noProgressMs: 180000,
      maxCallMs: 100000,
      repetitionRepeats: 12,
      reasoningLoopLines: 0,
      reasoningCycleRepeats: 3,
    });
  });

  it("resolves first_token_ms with project over global over default", () => {
    expect(resolveStreamWatchdog({ first_token_ms: 240000 }, { first_token_ms: 120000 })).toEqual({
      enabled: true,
      firstTokenMs: 120000,
      noProgressMs: 180000,
      maxCallMs: 600000,
      repetitionRepeats: 12,
      reasoningLoopLines: 0,
      reasoningCycleRepeats: 3,
    });
    expect(resolveStreamWatchdog(undefined, { first_token_ms: 90000 })).toEqual({
      enabled: true,
      firstTokenMs: 90000,
      noProgressMs: 180000,
      maxCallMs: 600000,
      repetitionRepeats: 12,
      reasoningLoopLines: 0,
      reasoningCycleRepeats: 3,
    });
  });

  it("resolves repetition_repeats with project over global over default, allowing 0 (disabled)", () => {
    expect(resolveStreamWatchdog({ repetition_repeats: 20 }, { repetition_repeats: 0 })).toEqual({
      enabled: true,
      firstTokenMs: 300000,
      noProgressMs: 180000,
      maxCallMs: 600000,
      repetitionRepeats: 0,
      reasoningLoopLines: 0,
      reasoningCycleRepeats: 3,
    });
    expect(resolveStreamWatchdog({ repetition_repeats: 20 }, undefined)).toEqual({
      enabled: true,
      firstTokenMs: 300000,
      noProgressMs: 180000,
      maxCallMs: 600000,
      repetitionRepeats: 20,
      reasoningLoopLines: 0,
      reasoningCycleRepeats: 3,
    });
  });

  it("repetition_repeats: 0 (the escape hatch) round-trips the raw schema; negatives do not", () => {
    expect(StreamWatchdogObjectSchema.safeParse({ repetition_repeats: 0 }).success).toBe(true);
    expect(StreamWatchdogObjectSchema.safeParse({ repetition_repeats: -1 }).success).toBe(false);
    expect(StreamWatchdogObjectSchema.safeParse({ repetition_repeats: 1.5 }).success).toBe(false);
  });

  it("resolves reasoning_loop_lines with project over global over default, allowing 0", () => {
    expect(
      resolveStreamWatchdog({ reasoning_loop_lines: 20 }, { reasoning_loop_lines: 0 }),
    ).toEqual({
      enabled: true,
      firstTokenMs: 300000,
      noProgressMs: 180000,
      maxCallMs: 600000,
      repetitionRepeats: 12,
      reasoningLoopLines: 0,
      reasoningCycleRepeats: 3,
    });
    expect(resolveStreamWatchdog({ reasoning_loop_lines: 20 }, undefined)).toEqual({
      enabled: true,
      firstTokenMs: 300000,
      noProgressMs: 180000,
      maxCallMs: 600000,
      repetitionRepeats: 12,
      reasoningLoopLines: 20,
      reasoningCycleRepeats: 3,
    });
  });

  it("resolves reasoning_cycle_repeats and accepts 0 as the escape hatch", () => {
    expect(
      resolveStreamWatchdog({ reasoning_cycle_repeats: 5 }, { reasoning_cycle_repeats: 0 }),
    ).toMatchObject({ reasoningCycleRepeats: 0 });
    expect(resolveStreamWatchdog({ reasoning_cycle_repeats: 5 })).toMatchObject({
      reasoningCycleRepeats: 5,
    });
    expect(StreamWatchdogObjectSchema.safeParse({ reasoning_cycle_repeats: 0 }).success).toBe(true);
    expect(StreamWatchdogObjectSchema.safeParse({ reasoning_cycle_repeats: 13 }).success).toBe(
      false,
    );
  });
});
