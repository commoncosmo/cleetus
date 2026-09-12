import type { RawSmokeRun } from "./schema";

/** Resolved smoke_run settings. */
export interface SmokeRunConfig {
  /** Window (seconds) used when the model omits `seconds`. */
  defaultSeconds: number;
  /** Upper bound the requested window is clamped to. */
  maxSeconds: number;
  /** Cap on lines of captured output surfaced to the model. */
  maxOutputLines: number;
}

export const DEFAULT_SMOKE_RUN: SmokeRunConfig = {
  defaultSeconds: 10,
  maxSeconds: 30,
  maxOutputLines: 100,
};

/** Resolve smoke_run settings with project > global > default precedence. Pure. */
export function resolveSmokeRun(global?: RawSmokeRun, project?: RawSmokeRun): SmokeRunConfig {
  return {
    defaultSeconds:
      project?.default_seconds ?? global?.default_seconds ?? DEFAULT_SMOKE_RUN.defaultSeconds,
    maxSeconds: project?.max_seconds ?? global?.max_seconds ?? DEFAULT_SMOKE_RUN.maxSeconds,
    maxOutputLines:
      project?.max_output_lines ?? global?.max_output_lines ?? DEFAULT_SMOKE_RUN.maxOutputLines,
  };
}
