import type { Event } from "./types";

export interface UsageTotals {
  input: number;
  output: number;
}

/** Accumulate token usage across all model_call_end events for a session. */
export function sumUsage(events: Event[]): UsageTotals {
  let input = 0;
  let output = 0;
  for (const e of events) {
    if (e.type !== "model_call_end") continue;
    const usage = (e.payload as { usage?: { input?: number; output?: number } }).usage;
    if (usage?.input) input += usage.input;
    if (usage?.output) output += usage.output;
  }
  return { input, output };
}
