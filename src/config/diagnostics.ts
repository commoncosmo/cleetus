import type { RawDiagnostics } from "./schema";
import type { DiagnosticsConfig } from "./types";

export const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 15000;
export const DEFAULT_DIAGNOSTICS_MAX_REPORTED = 10;

/** Merge global + project diagnostics config (project-over-global). Default: enabled. */
export function resolveDiagnostics(
  global?: RawDiagnostics,
  project?: RawDiagnostics,
): DiagnosticsConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? true,
    languages: project?.languages ?? global?.languages,
    timeoutMs: project?.timeout_ms ?? global?.timeout_ms ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS,
    maxReported: project?.max_reported ?? global?.max_reported ?? DEFAULT_DIAGNOSTICS_MAX_REPORTED,
  };
}
