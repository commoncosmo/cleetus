import { describe, expect, it } from "bun:test";
import { resolvePlanOrGo } from "../../src/config/plan-or-go";

describe("resolvePlanOrGo", () => {
  it("defaults to disabled when nothing is set", () => {
    expect(resolvePlanOrGo(undefined, undefined)).toEqual({ enabled: false });
  });

  it("lets project override global (project-over-global)", () => {
    expect(resolvePlanOrGo({ enabled: false }, { enabled: true })).toEqual({ enabled: true });
    expect(resolvePlanOrGo({ enabled: true }, { enabled: false })).toEqual({ enabled: false });
  });

  it("falls back to global when project omits the field", () => {
    expect(resolvePlanOrGo({ enabled: true }, {})).toEqual({ enabled: true });
  });

  it("honors a global-only setting", () => {
    expect(resolvePlanOrGo({ enabled: true }, undefined)).toEqual({ enabled: true });
  });
});
