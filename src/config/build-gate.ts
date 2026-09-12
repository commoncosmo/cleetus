import type { RawBuildGate } from "./schema";

/** Resolved orchestration build/coherence-gate settings. */
export interface BuildGateConfig {
  /** Master gate. No-op without a build command; orchestration itself is opt-in. */
  enabled: boolean;
  /** Bounded corrective worker rounds after a failed build. */
  maxAttempts: number;
  /** Kill the build command after this many ms. */
  timeoutMs: number;
  /** Cap on lines of build output surfaced in the failure tail. */
  maxOutputLines: number;
}

export const DEFAULT_BUILD_GATE: BuildGateConfig = {
  enabled: true,
  maxAttempts: 2,
  timeoutMs: 180_000,
  maxOutputLines: 80,
};

/** Resolve build_gate settings with project > global > default precedence. Pure. */
export function resolveBuildGate(global?: RawBuildGate, project?: RawBuildGate): BuildGateConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? DEFAULT_BUILD_GATE.enabled,
    maxAttempts: project?.max_attempts ?? global?.max_attempts ?? DEFAULT_BUILD_GATE.maxAttempts,
    timeoutMs: project?.timeout_ms ?? global?.timeout_ms ?? DEFAULT_BUILD_GATE.timeoutMs,
    maxOutputLines:
      project?.max_output_lines ?? global?.max_output_lines ?? DEFAULT_BUILD_GATE.maxOutputLines,
  };
}
