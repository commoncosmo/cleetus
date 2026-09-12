import type { RawPlanMode } from "./schema";

/** Resolved plan-mode guard settings. */
export interface PlanModeGuardConfig {
  /** After this many consecutive blocked mutating-tool attempts without a successful allowed
   *  inspection, force a tool-less plan synthesis pass. 0 disables the guard. */
  forcePlanAfterBlocks: number;
}

export const DEFAULT_PLAN_MODE_GUARD: PlanModeGuardConfig = {
  forcePlanAfterBlocks: 3,
};

/** Resolve plan-mode guard settings with project > global > default precedence. Pure. */
export function resolvePlanModeGuard(
  global?: RawPlanMode,
  project?: RawPlanMode,
): PlanModeGuardConfig {
  return {
    forcePlanAfterBlocks:
      project?.force_plan_after_blocks ??
      global?.force_plan_after_blocks ??
      DEFAULT_PLAN_MODE_GUARD.forcePlanAfterBlocks,
  };
}
