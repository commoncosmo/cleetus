import type { OrchestrationConfig } from "./orchestration";
import type { CleetusConfig, TierChoice } from "./types";

/**
 * Per-launch overrides for routing tiers and orchestration, sourced from CLI flags. The desktop
 * resolves `conversation ?? project ?? global` and passes the winner here; a hand-run CLI can pass
 * them directly. Flag values overlay (win over) the loaded config.
 *
 * Routing MODE is intentionally NOT here — it stays with `resolveStartRouteMode` at each router
 * build. This overlays only the pieces that had no prior flag path: routing tiers and orchestration
 * enabled/models.
 */
export interface LaunchOverrides {
  routeSmallProvider?: string;
  routeSmallModel?: string;
  routeLargeProvider?: string;
  routeLargeModel?: string;
  /** "on" | "off" (raw flag value; anything else is ignored with a warning). */
  orchestrate?: string;
  orchestratorProvider?: string;
  orchestratorModel?: string;
  workerProvider?: string;
  workerModel?: string;
}

export interface LaunchOverrideResult {
  config: CleetusConfig;
  warnings: string[];
}

function makeTier(provider?: string, model?: string): TierChoice | undefined {
  return provider && model ? { provider, model } : undefined;
}

/** Overlay CLI flag values onto a loaded config. Pure — returns a new config, never mutates input.
 *  Flag > config precedence; partial routing tiers are ignored with a warning. */
export function applyLaunchOverrides(
  config: CleetusConfig,
  overrides: LaunchOverrides,
): LaunchOverrideResult {
  const warnings: string[] = [];

  // --- Routing tiers (both small AND large required to form a valid pair) ---
  const small = makeTier(overrides.routeSmallProvider, overrides.routeSmallModel);
  const large = makeTier(overrides.routeLargeProvider, overrides.routeLargeModel);
  const anyTierFlag =
    overrides.routeSmallProvider !== undefined ||
    overrides.routeSmallModel !== undefined ||
    overrides.routeLargeProvider !== undefined ||
    overrides.routeLargeModel !== undefined;
  let routing = config.routing;
  if (small && large) {
    routing = { ...config.routing, tiers: { small, large } };
  } else if (anyTierFlag) {
    warnings.push(
      "incomplete routing tier flags; need small AND large each with provider+model; ignoring",
    );
  }

  // --- Orchestration (enabled + role models) ---
  const orchOverlay: Partial<OrchestrationConfig> = {};
  if (overrides.orchestrate !== undefined) {
    const v = overrides.orchestrate.trim().toLowerCase();
    if (v === "on") orchOverlay.enabled = true;
    else if (v === "off") orchOverlay.enabled = false;
    else
      warnings.push(`unknown --orchestrate '${overrides.orchestrate}', expected on|off; ignoring`);
  }
  if (overrides.orchestratorProvider)
    orchOverlay.orchestratorProvider = overrides.orchestratorProvider;
  if (overrides.orchestratorModel) orchOverlay.orchestratorModel = overrides.orchestratorModel;
  if (overrides.workerProvider) orchOverlay.workerProvider = overrides.workerProvider;
  if (overrides.workerModel) orchOverlay.workerModel = overrides.workerModel;
  const orchestration =
    Object.keys(orchOverlay).length > 0
      ? { ...config.orchestration, ...orchOverlay }
      : config.orchestration;

  return { config: { ...config, routing, orchestration }, warnings };
}
