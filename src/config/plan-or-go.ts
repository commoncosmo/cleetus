import type { RawPlanOrGo } from "./schema";
import type { PlanOrGoConfig } from "./types";

/** Resolve plan-or-go settings with project > global > default precedence. Pure.
 *  Default: disabled (opt-in). */
export function resolvePlanOrGo(global?: RawPlanOrGo, project?: RawPlanOrGo): PlanOrGoConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? false,
  };
}
