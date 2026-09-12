import { expect, test } from "bun:test";
import { applyLaunchOverrides } from "../../src/config/launch-overrides";
import { DEFAULT_ORCHESTRATION } from "../../src/config/orchestration";
import { DEFAULT_SMART_CONFIG } from "../../src/config/routing";
import type { CleetusConfig } from "../../src/config/types";

// Minimal config carrying only the fields the overlay reads/writes. Cast through unknown:
// applyLaunchOverrides only touches `routing` and `orchestration`, so the rest is irrelevant.
function makeConfig(overrides?: Partial<CleetusConfig>): CleetusConfig {
  return {
    routing: { defaultMode: "manual", tiers: undefined, smart: { ...DEFAULT_SMART_CONFIG } },
    orchestration: { ...DEFAULT_ORCHESTRATION },
    ...overrides,
  } as unknown as CleetusConfig;
}

test("no overrides: config passes through unchanged, no warnings", () => {
  const cfg = makeConfig();
  const { config, warnings } = applyLaunchOverrides(cfg, {});
  expect(config.routing.tiers).toBeUndefined();
  expect(config.orchestration.enabled).toBe(false);
  expect(warnings).toEqual([]);
});

test("both tiers supplied: routing.tiers is overlaid", () => {
  const { config, warnings } = applyLaunchOverrides(makeConfig(), {
    routeSmallProvider: "lm",
    routeSmallModel: "small-x",
    routeLargeProvider: "lm",
    routeLargeModel: "large-x",
  });
  expect(config.routing.tiers).toEqual({
    small: { provider: "lm", model: "small-x" },
    large: { provider: "lm", model: "large-x" },
  });
  expect(warnings).toEqual([]);
});

test("flag tiers win over config tiers", () => {
  const cfg = makeConfig({
    routing: {
      defaultMode: "smart",
      tiers: { small: { provider: "c", model: "cs" }, large: { provider: "c", model: "cl" } },
      smart: { ...DEFAULT_SMART_CONFIG },
    },
  });
  const { config } = applyLaunchOverrides(cfg, {
    routeSmallProvider: "f",
    routeSmallModel: "fs",
    routeLargeProvider: "f",
    routeLargeModel: "fl",
  });
  expect(config.routing.tiers).toEqual({
    small: { provider: "f", model: "fs" },
    large: { provider: "f", model: "fl" },
  });
});

test("partial tiers (only small): ignored with a warning, config tiers untouched", () => {
  const { config, warnings } = applyLaunchOverrides(makeConfig(), {
    routeSmallProvider: "lm",
    routeSmallModel: "small-x",
  });
  expect(config.routing.tiers).toBeUndefined();
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("routing tier");
});

test("orchestrate on: enabled true; off: enabled false (off beats a truthy default)", () => {
  const on = applyLaunchOverrides(makeConfig(), { orchestrate: "on" });
  expect(on.config.orchestration.enabled).toBe(true);
  const enabledCfg = makeConfig({
    orchestration: { ...DEFAULT_ORCHESTRATION, enabled: true },
  });
  const off = applyLaunchOverrides(enabledCfg, { orchestrate: "off" });
  expect(off.config.orchestration.enabled).toBe(false);
  expect(off.warnings).toEqual([]);
});

test("orchestrate garbage: ignored with a warning, enabled unchanged", () => {
  const { config, warnings } = applyLaunchOverrides(makeConfig(), { orchestrate: "yes" });
  expect(config.orchestration.enabled).toBe(false);
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("orchestrate");
});

test("orchestration models: non-empty overlay, empty/absent leaves config value", () => {
  const { config } = applyLaunchOverrides(makeConfig(), {
    orchestratorProvider: "op",
    orchestratorModel: "om",
    workerProvider: "wp",
    workerModel: "wm",
  });
  expect(config.orchestration.orchestratorProvider).toBe("op");
  expect(config.orchestration.orchestratorModel).toBe("om");
  expect(config.orchestration.workerProvider).toBe("wp");
  expect(config.orchestration.workerModel).toBe("wm");
  // empty string = "don't override" (config semantics: "" means inherit active)
  const untouched = applyLaunchOverrides(makeConfig(), { orchestratorModel: "" });
  expect(untouched.config.orchestration.orchestratorModel).toBe("");
});

test("does not mutate the input config", () => {
  const cfg = makeConfig();
  applyLaunchOverrides(cfg, {
    routeSmallProvider: "lm",
    routeSmallModel: "s",
    routeLargeProvider: "lm",
    routeLargeModel: "l",
    orchestrate: "on",
  });
  expect(cfg.routing.tiers).toBeUndefined();
  expect(cfg.orchestration.enabled).toBe(false);
});
