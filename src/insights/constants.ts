/** Minimum allows (with zero denies) before suggesting a (tool,args) for the allowlist. */
export const ALWAYS_ALLOW_SUGGEST_THRESHOLD = 5;
/** Per-tool error messages retained in the report. */
export const TOP_ERRORS = 3;
/** Worst-offender trajectories sent to the opt-in --explain pass. */
export const EXPLAIN_SAMPLE_CAP = 5;
/**
 * Legacy sentinel assistant-message notes. The runtime now stamps a structured
 * `stoppedReason` marker on the terminal assistant_message event, which trajectory.ts
 * prefers. These strings remain ONLY so older logs (recorded before the marker existed)
 * still classify correctly — do not "fix" them to match current runtime wording.
 */
export const CANCELLED_NOTE = "(cancelled)";
export const LOOP_LIMIT_NOTE = "(stopped after reaching the tool-call limit)";
