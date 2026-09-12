import { describe, expect, it } from "bun:test";
import { buildAcpRouter } from "../../src/acp/router";
import type { TurnContext } from "../../src/agent/selector";
import type { RoutingConfig, SmartConfig } from "../../src/config/types";

const active = { provider: "p", model: "active-model" };
const small = { provider: "p", model: "small-model" };
const large = { provider: "p", model: "large-model" };

// smart config tuned so ONLY consecutive tool failures escalate:
// high char threshold, no code-edit escalation, no keywords.
const smart: SmartConfig = {
  escalateAfterFailures: 3,
  deescalateAfterSuccesses: 2,
  broadCodePlanCalls: 5,
  contextWindowPercent: 100,
  escalateOnCodeEdit: "never",
  keywords: [],
};

function routing(defaultMode: RoutingConfig["defaultMode"], withTiers: boolean): RoutingConfig {
  return {
    defaultMode,
    tiers: withTiers ? { small, large } : undefined,
    smart,
  };
}

const ctx = (turnIndex: number): TurnContext => ({ turnIndex, messages: [] });

describe("buildAcpRouter", () => {
  it("manual: selects the active model, no finish pass", () => {
    const { router, warnings } = buildAcpRouter(routing("manual", true), active);
    const d = router.select(ctx(0));
    expect(d.choice).toEqual(active);
    expect(d.tier).toBeNull();
    expect(router.finishPass()).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("speed + tiers: small for steps, large for the finish pass", () => {
    const { router } = buildAcpRouter(routing("speed", true), active);
    const d = router.select(ctx(0));
    expect(d.choice).toEqual(small);
    expect(d.tier).toBe("small");
    const fp = router.finishPass();
    expect(fp?.choice).toEqual(large);
    expect(fp?.tier).toBe("large");
  });

  it("smart + tiers, no escalation signal: stays small", () => {
    const { router } = buildAcpRouter(routing("smart", true), active);
    const d = router.select(ctx(0));
    expect(d.choice).toEqual(small);
    expect(d.tier).toBe("small");
  });

  it("smart + tiers, escalation signal: goes large", () => {
    const { router } = buildAcpRouter(routing("smart", true), active);
    const d = router.select({
      ...ctx(3),
      toolProgress: { calls: 3, failures: 3, consecutiveFailures: 3 },
    });
    expect(d.choice).toEqual(large);
    expect(d.tier).toBe("large");
  });

  it("speed without tiers: downgrades to manual with a warning", () => {
    const { router, warnings } = buildAcpRouter(routing("speed", false), active);
    expect(warnings.length).toBeGreaterThan(0);
    const d = router.select(ctx(0));
    expect(d.choice).toEqual(active);
  });

  it("routeFlag overrides config default_mode (smart on top of a manual config)", () => {
    const { router } = buildAcpRouter(routing("manual", true), active, "smart");
    const d = router.select({
      ...ctx(3),
      toolProgress: { calls: 3, failures: 3, consecutiveFailures: 3 },
    });
    expect(d.choice).toEqual(large);
    expect(d.tier).toBe("large");
  });

  it("routeFlag 'manual' forces the active model even when config says smart", () => {
    const { router } = buildAcpRouter(routing("smart", true), active, "manual");
    const d = router.select(ctx(3));
    expect(d.choice).toEqual(active);
    expect(d.tier).toBeNull();
  });

  it("unknown routeFlag is ignored with a warning, config mode stands", () => {
    const { router, warnings } = buildAcpRouter(routing("manual", true), active, "bogus");
    expect(warnings.some((w) => w.includes("bogus"))).toBe(true);
    expect(router.select(ctx(3)).choice).toEqual(active);
  });

  it("uses live ACP session accessors between turns", () => {
    let mode: RoutingConfig["defaultMode"] = "manual";
    let selected = active;
    const { router } = buildAcpRouter(routing("manual", true), active, undefined, {
      getMode: () => mode,
      getActive: () => selected,
    });
    selected = { provider: "other", model: "changed-model" };
    expect(router.select(ctx(0)).choice).toEqual(selected);
    mode = "speed";
    expect(router.select(ctx(1)).choice).toEqual(small);
  });
});
