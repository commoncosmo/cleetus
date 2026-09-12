import { describe, expect, it } from "bun:test";
import { buildSkillRegistry, skillRegistryWarnings } from "../../src/skills/registry";
import type { Skill } from "../../src/skills/types";

const builtin: Skill = { name: "scan", description: "builtin scan", source: "built-in", body: "B" };
const globalScan: Skill = { name: "scan", description: "global scan", source: "global", body: "G" };
const projectScan: Skill = {
  name: "scan",
  description: "project scan",
  source: "project",
  body: "P",
};
const projectOther: Skill = { name: "alpha", description: "a", source: "project", body: "A" };

describe("buildSkillRegistry", () => {
  it("project overrides global overrides built-in by name", () => {
    const reg = buildSkillRegistry([builtin], [projectScan, globalScan]);
    expect(reg.get("scan")!.body).toBe("P");
  });

  it("global overrides built-in when there is no project skill", () => {
    const reg = buildSkillRegistry([builtin], [globalScan]);
    expect(reg.get("scan")!.body).toBe("G");
  });

  it("lists skills sorted by name", () => {
    const reg = buildSkillRegistry([builtin], [projectOther]);
    expect(reg.list().map((s) => s.name)).toEqual(["alpha", "scan"]);
  });

  it("upserts a skill into the live registry", () => {
    const reg = buildSkillRegistry([builtin], []);
    const learned: Skill = {
      name: "weather",
      description: "learned weather workflow",
      source: "global",
      body: "fetch it",
      trigger: { when: [], match: ["weather"] },
    };
    reg.upsert(learned);
    expect(reg.get("weather")).toEqual(learned);
    expect(reg.list().map((skill) => skill.name)).toEqual(["scan", "weather"]);
  });

  it("resolveName matches exact, unambiguous prefix, else null", () => {
    const reg = buildSkillRegistry([builtin], [projectOther]);
    expect(reg.resolveName("scan")).toBe("scan");
    expect(reg.resolveName("al")).toBe("alpha");
    expect(reg.resolveName("zzz")).toBeNull();
    expect(reg.resolveName("")).toBeNull();
  });

  it("resolveName returns null on an ambiguous prefix", () => {
    const reg = buildSkillRegistry(
      [
        { name: "scan-a", description: "", source: "built-in", body: "x" },
        { name: "scan-b", description: "", source: "built-in", body: "y" },
      ],
      [],
    );
    expect(reg.resolveName("scan")).toBeNull();
  });
});

describe("skillRegistryWarnings", () => {
  it("reports exact-name shadowing across scopes", () => {
    const warnings = skillRegistryWarnings([builtin], [globalScan, projectScan]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("project");
    expect(warnings[0]).toContain("shadows");
  });

  it("reports overlapping triggers in a shared non-composable capability", () => {
    const first: Skill = {
      name: "weather-a",
      description: "",
      source: "global",
      body: "a",
      capability: "weather-forecast",
      trigger: { when: [], match: ["weather"] },
    };
    const second: Skill = {
      name: "weather-b",
      description: "",
      source: "project",
      body: "b",
      capability: "weather-forecast",
      trigger: { when: [], match: ["weather forecast"] },
    };
    expect(skillRegistryWarnings([], [first, second])[0]).toContain(
      "share capability 'weather-forecast'",
    );
  });

  it("does not warn about intentional composition", () => {
    const first: Skill = {
      name: "weather-a",
      description: "",
      source: "global",
      body: "a",
      capability: "weather-forecast",
      compose: true,
      trigger: { when: [], match: ["weather"] },
    };
    const second: Skill = {
      name: "weather-b",
      description: "",
      source: "project",
      body: "b",
      capability: "weather-forecast",
      trigger: { when: [], match: ["weather"] },
    };
    expect(skillRegistryWarnings([], [first, second])).toEqual([]);
  });
});
