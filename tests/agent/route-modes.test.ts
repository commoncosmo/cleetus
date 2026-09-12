import { describe, expect, it } from "bun:test";
import {
  ROUTE_MODES,
  completeRouteLine,
  resolveRouteName,
  resolveStartRouteMode,
  routeModeInfo,
} from "../../src/agent/route-modes";
import { DEFAULT_SMART_CONFIG } from "../../src/config/routing";
import type { RoutingConfig } from "../../src/config/types";

describe("route-modes", () => {
  it("lists the three modes in order", () => {
    expect(ROUTE_MODES.map((m) => m.id)).toEqual(["manual", "speed", "smart"]);
  });

  it("resolves exact and unambiguous-prefix names", () => {
    expect(resolveRouteName("speed")).toBe("speed");
    expect(resolveRouteName("sm")).toBe("smart"); // only "smart" starts with "sm"
    expect(resolveRouteName("ma")).toBe("manual");
  });

  it("returns null for unknown or ambiguous names", () => {
    expect(resolveRouteName("nope")).toBeNull();
    expect(resolveRouteName("s")).toBeNull(); // speed + smart both match
    expect(resolveRouteName("")).toBeNull();
  });

  it("completes a /route line", () => {
    const out = completeRouteLine("/route sp");
    expect(out).toEqual([{ display: expect.stringContaining("speed"), value: "/route speed" }]);
  });

  it("returns no completions for a non-matching partial and all for empty", () => {
    expect(completeRouteLine("/route xyz")).toEqual([]);
    expect(completeRouteLine("/route ").map((c) => c.value)).toEqual([
      "/route manual",
      "/route speed",
      "/route smart",
    ]);
  });

  it("looks up mode info by id", () => {
    expect(routeModeInfo("speed").id).toBe("speed");
    expect(routeModeInfo("manual").description).toContain("currently selected");
  });
});

const withTiers: RoutingConfig = {
  defaultMode: "manual",
  tiers: { small: { provider: "lm", model: "s" }, large: { provider: "rm", model: "l" } },
  smart: DEFAULT_SMART_CONFIG,
};
const noTiers: RoutingConfig = { defaultMode: "manual", smart: DEFAULT_SMART_CONFIG };

describe("resolveStartRouteMode", () => {
  it("uses config defaultMode when no flag", () => {
    const r = resolveStartRouteMode({ ...withTiers, defaultMode: "speed" }, undefined);
    expect(r).toEqual({ mode: "speed", warnings: [] });
  });

  it("a valid --route flag overrides config defaultMode", () => {
    const r = resolveStartRouteMode({ ...withTiers, defaultMode: "manual" }, "smart");
    expect(r.mode).toBe("smart");
    expect(r.warnings).toEqual([]);
  });

  it("warns and ignores an unknown --route flag", () => {
    const r = resolveStartRouteMode(withTiers, "bogus");
    expect(r.mode).toBe("manual"); // falls back to config defaultMode
    expect(r.warnings.some((w) => w.includes("unknown --route"))).toBe(true);
  });

  it("downgrades speed to manual with a warning when no tiers configured", () => {
    const r = resolveStartRouteMode({ ...noTiers, defaultMode: "speed" }, undefined);
    expect(r.mode).toBe("manual");
    expect(r.warnings.some((w) => w.includes("needs routing.tiers"))).toBe(true);
  });

  it("downgrades a smart --route flag to manual when no tiers configured", () => {
    const r = resolveStartRouteMode(noTiers, "speed");
    expect(r.mode).toBe("manual");
    expect(r.warnings.length).toBe(1);
  });
});
