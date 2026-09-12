import type { RawRouting } from "./schema";
import type { RoutingConfig, SmartConfig } from "./types";

export const DEFAULT_SMART_CONFIG: SmartConfig = {
  escalateAfterFailures: 3,
  deescalateAfterSuccesses: 2,
  contextWindowPercent: 70,
  escalateOnCodeEdit: "on_verify_fail",
  keywords: ["think hard"],
  broadCodePlanCalls: 5,
};

/** Normalize the raw `escalate_on_code_edit` field (legacy boolean or the tri-state string) to
 * the resolved tri-state. `undefined` is left to the caller's own default fallback. */
function normalizeEscalateOnCodeEdit(
  raw: boolean | SmartConfig["escalateOnCodeEdit"] | undefined,
): SmartConfig["escalateOnCodeEdit"] | undefined {
  if (raw === true) return "always";
  if (raw === false) return "never";
  return raw;
}

/** Merge global + project routing (project wins per field) and apply defaults. */
export function resolveRouting(global?: RawRouting, project?: RawRouting): RoutingConfig {
  const rawTiers = project?.tiers ?? global?.tiers;
  const tiers = rawTiers
    ? {
        small: { provider: rawTiers.small.provider, model: rawTiers.small.model },
        large: { provider: rawTiers.large.provider, model: rawTiers.large.model },
      }
    : undefined;

  // Auto-engage: tiers configured but no explicit mode → default to smart so routing "just works"
  // once tiers exist. No tiers → manual. An explicit default_mode always wins.
  const explicitMode = project?.default_mode ?? global?.default_mode;
  const defaultMode = explicitMode ?? (tiers ? "smart" : "manual");

  const gs = global?.smart;
  const ps = project?.smart;
  const explicitContextWindowPercent = ps?.context_window_percent ?? gs?.context_window_percent;
  const smart: SmartConfig = {
    escalateAfterFailures:
      ps?.escalate_after_failures ??
      ps?.escalate_after_tools ??
      gs?.escalate_after_failures ??
      gs?.escalate_after_tools ??
      DEFAULT_SMART_CONFIG.escalateAfterFailures,
    deescalateAfterSuccesses:
      ps?.deescalate_after_successes ??
      gs?.deescalate_after_successes ??
      DEFAULT_SMART_CONFIG.deescalateAfterSuccesses,
    contextWindowPercent: explicitContextWindowPercent ?? DEFAULT_SMART_CONFIG.contextWindowPercent,
    escalateOnCodeEdit:
      normalizeEscalateOnCodeEdit(ps?.escalate_on_code_edit) ??
      normalizeEscalateOnCodeEdit(gs?.escalate_on_code_edit) ??
      DEFAULT_SMART_CONFIG.escalateOnCodeEdit,
    keywords: ps?.keywords ?? gs?.keywords ?? [...DEFAULT_SMART_CONFIG.keywords],
    broadCodePlanCalls:
      ps?.broad_code_plan_calls ??
      gs?.broad_code_plan_calls ??
      DEFAULT_SMART_CONFIG.broadCodePlanCalls,
  };

  return { defaultMode, tiers, smart };
}
