import { type RouteMode, resolveStartRouteMode } from "../agent/route-modes";
import { type Router, createRouter } from "../agent/router";
import type { ModelChoice } from "../agent/selector";
import type { RoutingConfig } from "../config/types";

/** Build the chat (ACP) router from `config.routing`. The launch flag establishes the initial
 * mode; optional live accessors let ACP session configuration change route/provider/model between
 * turns. Returns the initial mode and any startup warnings for the caller to surface. */
export function buildAcpRouter(
  routing: RoutingConfig,
  active: ModelChoice,
  routeFlag?: string,
  live?: { getMode: () => RouteMode; getActive: () => ModelChoice },
): { router: Router; mode: RouteMode; warnings: string[] } {
  const { mode, warnings } = resolveStartRouteMode(routing, routeFlag);
  const router = createRouter({
    getMode: live?.getMode ?? (() => mode),
    getActive: live?.getActive ?? (() => active),
    tiers: routing.tiers,
    smart: routing.smart,
  });
  return { router, mode, warnings };
}
