import { describe, expect, it } from "bun:test";
import { BUILTIN_SKILLS } from "../../src/skills/builtins";
import { completeSkillLine } from "../../src/skills/complete";
import { buildSkillRegistry } from "../../src/skills/registry";

const registry = buildSkillRegistry(BUILTIN_SKILLS, []);

describe("completeSkillLine", () => {
  it("lists all skills for an empty partial (trailing space)", () => {
    const out = completeSkillLine(registry, "/skill ");
    expect(out.map((s) => s.value)).toEqual([
      "/skill security-scan ",
      "/skill spec-creator ",
      "/skill test-driven-development ",
      "/skill workflow-creator ",
    ]);
    expect(out[0]!.display).toBe(`security-scan — ${registry.get("security-scan")!.description}`);
  });

  it("filters by case-insensitive substring, matching mid-name", () => {
    expect(completeSkillLine(registry, "/skill sec").map((s) => s.value)).toEqual([
      "/skill security-scan ",
    ]);
    // "dev" is a substring of test-driven-DEVelopment; case-insensitive.
    expect(completeSkillLine(registry, "/skill DEV").map((s) => s.value)).toEqual([
      "/skill test-driven-development ",
    ]);
  });

  it("returns [] for a non-matching partial", () => {
    expect(completeSkillLine(registry, "/skill nope")).toEqual([]);
  });

  it("returns [] once the name is complete and a space follows (into args)", () => {
    expect(completeSkillLine(registry, "/skill security-scan ")).toEqual([]);
  });

  it("returns [] for a bare `/skill` with no trailing space (that stage is completeSlashLine)", () => {
    expect(completeSkillLine(registry, "/skill")).toEqual([]);
  });

  it("returns [] for lines that are not a /skill line", () => {
    expect(completeSkillLine(registry, "")).toEqual([]);
    expect(completeSkillLine(registry, "hello")).toEqual([]);
    expect(completeSkillLine(registry, "/route foo")).toEqual([]);
  });
});
