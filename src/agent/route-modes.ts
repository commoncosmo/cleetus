import type { RoutingConfig } from "../config/types";

/** Model-routing modes the user can switch between at runtime (via `/route`). */
export type RouteMode = "manual" | "speed" | "smart";

export interface RouteModeInfo {
  id: RouteMode;
  description: string;
}

export const ROUTE_MODES: RouteModeInfo[] = [
  { id: "manual", description: "Use the currently selected model; no automatic switching" },
  { id: "speed", description: "Small tier for tool steps; large tier writes the final answer" },
  { id: "smart", description: "Default to small; escalate to large on hard turns" },
];

export function routeModeInfo(id: RouteMode): RouteModeInfo {
  return ROUTE_MODES.find((m) => m.id === id)!;
}

/**
 * Resolve a typed `/route <arg>` to a mode. Accepts an exact id or an
 * unambiguous prefix. Returns null when nothing (or more than one) matches.
 */
export function resolveRouteName(arg: string): RouteMode | null {
  const a = arg.trim().toLowerCase();
  if (!a) return null;
  const exact = ROUTE_MODES.find((m) => m.id === a);
  if (exact) return exact.id;
  const prefixed = ROUTE_MODES.filter((m) => m.id.startsWith(a));
  return prefixed.length === 1 ? prefixed[0]!.id : null;
}

export interface RouteCompletion {
  display: string;
  value: string;
}

export interface StartRouteResolution {
  mode: RouteMode;
  /** Human-readable warnings the caller should surface (e.g. to stderr). */
  warnings: string[];
}

/**
 * Resolve the startup routing mode from config + an optional `--route` flag.
 * Unknown flag → ignored with a warning. speed/smart without configured tiers →
 * downgraded to manual with a warning. Pure; the caller emits the warnings.
 */
export function resolveStartRouteMode(
  routing: RoutingConfig,
  flag: string | undefined,
): StartRouteResolution {
  const warnings: string[] = [];
  let mode: RouteMode = routing.defaultMode;
  if (flag) {
    const m = resolveRouteName(flag);
    if (!m) warnings.push(`unknown --route '${flag}', ignoring`);
    else mode = m;
  }
  if ((mode === "speed" || mode === "smart") && !routing.tiers) {
    warnings.push(`routing mode '${mode}' needs routing.tiers; falling back to manual`);
    mode = "manual";
  }
  return { mode, warnings };
}

/** Autocomplete candidates for a `/route <partial>` line (mirrors completeModeLine). */
export function completeRouteLine(line: string): RouteCompletion[] {
  const m = /^\/route\s+(.*)$/.exec(line);
  if (!m) return [];
  const partial = m[1]!.toLowerCase();
  return ROUTE_MODES.filter((mode) => mode.id.includes(partial)).map((mode) => ({
    display: `${mode.id} — ${mode.description}`,
    value: `/route ${mode.id}`,
  }));
}
