import type { RawLoopGuard } from "./schema";

/** Resolved tool-loop no-progress guard settings. */
export interface LoopGuardConfig {
  enabled: boolean;
  /** Same-path edit count within the window that triggers a warning. */
  editRepeatThreshold: number;
  /** Consecutive identical-command failures within the window that trigger a warning. */
  failRepeatThreshold: number;
  /** Number of most-recent tool calls considered. */
  windowSize: number;
  /** Calls to suppress re-warning a signature after it warns. */
  cooldown: number;
  /** Identical no-progress tool-call repeats within the window (any exit code) that trigger a
   *  stall warning — catches re-listing, re-reading, and re-planning loops. */
  noProgressThreshold: number;
  /** Out-of-tree attempts within the window (any target) that trigger an escape warning. */
  escapeThreshold: number;
  /** Warnings on the same fail/stall signature after which the call is refused pre-dispatch
   *  (not just warned). `0` disables blocking (warn-only). Any successful edit resets the counts. */
  blockThreshold: number;
  /** Hidden-tool rejections within the window (any tool name) that trigger a warning; the
   *  runtime aborts the turn at 2x this count (WS5 N3). */
  hiddenRepeatThreshold: number;
  /** Consecutive identical-command FAILURES (cleared only by a successful run of that command,
   *  NOT by an intervening edit) after which a PLAIN session's turn is aborted with
   *  stoppedReason "thrash". Distinct from orchestration.worker_thrash_repeats. `0` disables. */
  cmdFailAbort: number;
}

export const DEFAULT_LOOP_GUARD: LoopGuardConfig = {
  enabled: true,
  editRepeatThreshold: 5,
  failRepeatThreshold: 3,
  windowSize: 12,
  cooldown: 6,
  noProgressThreshold: 4,
  escapeThreshold: 2,
  blockThreshold: 2,
  hiddenRepeatThreshold: 3,
  cmdFailAbort: 6,
};

/** Resolve loop-guard settings with project > global > default precedence. Pure. */
export function resolveLoopGuard(global?: RawLoopGuard, project?: RawLoopGuard): LoopGuardConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? DEFAULT_LOOP_GUARD.enabled,
    editRepeatThreshold:
      project?.edit_repeat_threshold ??
      global?.edit_repeat_threshold ??
      DEFAULT_LOOP_GUARD.editRepeatThreshold,
    failRepeatThreshold:
      project?.fail_repeat_threshold ??
      global?.fail_repeat_threshold ??
      DEFAULT_LOOP_GUARD.failRepeatThreshold,
    windowSize: project?.window_size ?? global?.window_size ?? DEFAULT_LOOP_GUARD.windowSize,
    cooldown: project?.cooldown ?? global?.cooldown ?? DEFAULT_LOOP_GUARD.cooldown,
    noProgressThreshold:
      project?.no_progress_threshold ??
      global?.no_progress_threshold ??
      DEFAULT_LOOP_GUARD.noProgressThreshold,
    escapeThreshold:
      project?.escape_threshold ?? global?.escape_threshold ?? DEFAULT_LOOP_GUARD.escapeThreshold,
    blockThreshold:
      project?.block_threshold ?? global?.block_threshold ?? DEFAULT_LOOP_GUARD.blockThreshold,
    hiddenRepeatThreshold:
      project?.hidden_repeat_threshold ??
      global?.hidden_repeat_threshold ??
      DEFAULT_LOOP_GUARD.hiddenRepeatThreshold,
    cmdFailAbort:
      project?.cmd_fail_abort ?? global?.cmd_fail_abort ?? DEFAULT_LOOP_GUARD.cmdFailAbort,
  };
}
