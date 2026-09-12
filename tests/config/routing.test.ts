import { describe, expect, it } from "bun:test";
import { resolveRouting } from "../../src/config/routing";

const tiers = {
  small: { provider: "p", model: "small" },
  large: { provider: "p", model: "large" },
};

describe("resolveRouting default_mode auto-promotion", () => {
  it("defaults to smart when tiers are configured and no mode is set", () => {
    expect(resolveRouting(undefined, { tiers }).defaultMode).toBe("smart");
  });
  it("defaults to manual when no tiers are configured", () => {
    expect(resolveRouting(undefined, {}).defaultMode).toBe("manual");
  });
  it("respects an explicit default_mode over auto-promotion", () => {
    expect(resolveRouting(undefined, { tiers, default_mode: "speed" }).defaultMode).toBe("speed");
    expect(resolveRouting(undefined, { tiers, default_mode: "manual" }).defaultMode).toBe("manual");
  });
  it("auto-promotes to smart from global tiers when project sets nothing", () => {
    expect(resolveRouting({ tiers }, {}).defaultMode).toBe("smart");
  });
  it("a global explicit default_mode beats project-tier auto-promotion", () => {
    expect(resolveRouting({ default_mode: "manual" }, { tiers }).defaultMode).toBe("manual");
  });
});

describe("resolveRouting smart.escalate_on_code_edit normalization", () => {
  it("defaults to on_verify_fail when unset", () => {
    expect(resolveRouting(undefined, {}).smart.escalateOnCodeEdit).toBe("on_verify_fail");
  });
  it("aliases boolean true to always", () => {
    expect(
      resolveRouting(undefined, { smart: { escalate_on_code_edit: true } }).smart
        .escalateOnCodeEdit,
    ).toBe("always");
  });
  it("aliases boolean false to never", () => {
    expect(
      resolveRouting(undefined, { smart: { escalate_on_code_edit: false } }).smart
        .escalateOnCodeEdit,
    ).toBe("never");
  });
  it("passes through an explicit string value", () => {
    expect(
      resolveRouting(undefined, { smart: { escalate_on_code_edit: "on_verify_fail" } }).smart
        .escalateOnCodeEdit,
    ).toBe("on_verify_fail");
    expect(
      resolveRouting(undefined, { smart: { escalate_on_code_edit: "never" } }).smart
        .escalateOnCodeEdit,
    ).toBe("never");
  });
  it("project value overrides global value", () => {
    expect(
      resolveRouting(
        { smart: { escalate_on_code_edit: "always" } },
        { smart: { escalate_on_code_edit: "never" } },
      ).smart.escalateOnCodeEdit,
    ).toBe("never");
  });
});

describe("resolveRouting smart.keywords default", () => {
  it("defaults to just think hard (carefully was too common a word)", () => {
    expect(resolveRouting(undefined, {}).smart.keywords).toEqual(["think hard"]);
  });
});

describe("resolveRouting smart.deescalate_after_successes", () => {
  it("defaults to 2", () => {
    expect(resolveRouting(undefined, {}).smart.deescalateAfterSuccesses).toBe(2);
  });
  it("respects an explicit value, project over global", () => {
    expect(
      resolveRouting(undefined, { smart: { deescalate_after_successes: 5 } }).smart
        .deescalateAfterSuccesses,
    ).toBe(5);
    expect(
      resolveRouting(
        { smart: { deescalate_after_successes: 5 } },
        { smart: { deescalate_after_successes: 1 } },
      ).smart.deescalateAfterSuccesses,
    ).toBe(1);
  });
});

describe("resolveRouting smart.broad_code_plan_calls", () => {
  it("defaults to 5", () => {
    expect(resolveRouting(undefined, {}).smart.broadCodePlanCalls).toBe(5);
  });
  it("respects an explicit value, project over global", () => {
    expect(
      resolveRouting(undefined, { smart: { broad_code_plan_calls: 8 } }).smart.broadCodePlanCalls,
    ).toBe(8);
    expect(
      resolveRouting(
        { smart: { broad_code_plan_calls: 8 } },
        { smart: { broad_code_plan_calls: 2 } },
      ).smart.broadCodePlanCalls,
    ).toBe(2);
  });
});
