import type { RawStreamWatchdog } from "./schema";

/** Per-call stream watchdog. Timers feed one abort:
 *  - `firstTokenMs`: max silence BEFORE the first stream event. Covers time-to-first-token,
 *    which includes the inference server loading a model — larger than `noProgressMs` so a cold
 *    heavy-model load isn't mistaken for a hang.
 *  - `noProgressMs`: max stream silence AFTER streaming has begun. RESETS on any activity
 *    (text, reasoning, or tool-call argument deltas) — catches genuine mid-stream hangs.
 *  - `maxCallMs`: absolute wall-clock a single call may run regardless of activity. Armed
 *    once and NEVER reset — backstops a continuously-streaming runaway loop.
 *  - `repetitionRepeats`: consecutive repeats of a short unit at the stream's end that
 *    abort the call as degenerate repetition (see src/agent/repetition.ts). 0 disables.
 *  - `reasoningLoopLines`: a normalized reasoning line recurring this many times (even
 *    non-consecutively) aborts the call as a rumination loop (see ReasoningLoopDetector). 0 disables.
 *  - `reasoningCycleRepeats`: consecutive byte-identical long reasoning blocks required before
 *    aborting an exact planning cycle. 0 disables. */
export interface StreamWatchdogConfig {
  enabled: boolean;
  firstTokenMs: number;
  noProgressMs: number;
  maxCallMs: number;
  repetitionRepeats: number;
  reasoningLoopLines: number;
  reasoningCycleRepeats?: number;
}

export const DEFAULT_STREAM_WATCHDOG: StreamWatchdogConfig = {
  enabled: true,
  firstTokenMs: 300000,
  noProgressMs: 180000,
  maxCallMs: 600000,
  repetitionRepeats: 12,
  // Non-consecutive prose recurrence is only circumstantial evidence: coding models naturally
  // reuse planning phrases while doing different work. Keep the detector available as an opt-in,
  // but rely by default on silence, the wall-clock ceiling, and consecutive byte repetition.
  reasoningLoopLines: 0,
  reasoningCycleRepeats: 3,
};

/** Resolve watchdog settings with project > global > default precedence. Pure. */
export function resolveStreamWatchdog(
  global?: RawStreamWatchdog,
  project?: RawStreamWatchdog,
): StreamWatchdogConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? DEFAULT_STREAM_WATCHDOG.enabled,
    firstTokenMs:
      project?.first_token_ms ?? global?.first_token_ms ?? DEFAULT_STREAM_WATCHDOG.firstTokenMs,
    noProgressMs:
      project?.no_progress_ms ?? global?.no_progress_ms ?? DEFAULT_STREAM_WATCHDOG.noProgressMs,
    maxCallMs: project?.max_call_ms ?? global?.max_call_ms ?? DEFAULT_STREAM_WATCHDOG.maxCallMs,
    repetitionRepeats:
      project?.repetition_repeats ??
      global?.repetition_repeats ??
      DEFAULT_STREAM_WATCHDOG.repetitionRepeats,
    reasoningLoopLines:
      project?.reasoning_loop_lines ??
      global?.reasoning_loop_lines ??
      DEFAULT_STREAM_WATCHDOG.reasoningLoopLines,
    reasoningCycleRepeats:
      project?.reasoning_cycle_repeats ??
      global?.reasoning_cycle_repeats ??
      DEFAULT_STREAM_WATCHDOG.reasoningCycleRepeats,
  };
}
