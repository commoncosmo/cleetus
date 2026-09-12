import { describe, expect, it } from "bun:test";
import { resolveSkills } from "../../src/config/skills";

describe("resolveSkills", () => {
  it("defaults to enabled when nothing is set", () => {
    expect(resolveSkills(undefined, undefined)).toEqual({ enabled: true, autoInvoke: true });
  });

  it("lets the project value beat the global value", () => {
    expect(resolveSkills({ enabled: true }, { enabled: false })).toEqual({
      enabled: false,
      autoInvoke: true,
    });
  });

  it("uses the global value when the project omits it", () => {
    expect(resolveSkills({ enabled: false }, undefined)).toEqual({
      enabled: false,
      autoInvoke: true,
    });
  });
});

describe("resolveSkills — autoInvoke", () => {
  it("defaults autoInvoke to true", () => {
    expect(resolveSkills(undefined, undefined).autoInvoke).toBe(true);
  });
  it("honors project auto_invoke over global", () => {
    expect(resolveSkills({ auto_invoke: true }, { auto_invoke: false }).autoInvoke).toBe(false);
  });
  it("falls back to global auto_invoke when project is unset", () => {
    expect(resolveSkills({ auto_invoke: false }, undefined).autoInvoke).toBe(false);
  });
});
