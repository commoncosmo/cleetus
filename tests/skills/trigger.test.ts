import { describe, expect, it } from "bun:test";
import { triggeredSkills } from "../../src/skills/trigger";
import type { Skill } from "../../src/skills/types";

function skill(name: string, trigger?: Skill["trigger"], extra: Partial<Skill> = {}): Skill {
  return {
    name,
    description: "d",
    source: "built-in",
    body: "b",
    ...(trigger ? { trigger } : {}),
    ...extra,
  };
}

const tdd = skill("tdd", { when: ["coding-task"], match: [] });
const kw = skill("kw", { when: [], match: ["deploy", "ship it"] });
const manual = skill("manual"); // no trigger

describe("triggeredSkills", () => {
  it("fires a `when: coding-task` skill on an imperative dev request", () => {
    expect(triggeredSkills([tdd], "add a rate limiter").map((s) => s.name)).toEqual(["tdd"]);
    expect(triggeredSkills([tdd], "fix the parser").map((s) => s.name)).toEqual(["tdd"]);
    expect(triggeredSkills([tdd], "refactor the router").map((s) => s.name)).toEqual(["tdd"]);
  });

  it("does NOT fire `coding-task` on a question", () => {
    expect(triggeredSkills([tdd], "how would I refactor this?")).toEqual([]);
    expect(triggeredSkills([tdd], "what is a rate limiter?")).toEqual([]);
  });

  it("fires a `match` skill on a case-insensitive substring hit", () => {
    expect(triggeredSkills([kw], "please DEPLOY the service").map((s) => s.name)).toEqual(["kw"]);
    expect(triggeredSkills([kw], "let's ship it now").map((s) => s.name)).toEqual(["kw"]);
  });

  it("does NOT fire a `match` skill when no substring is present", () => {
    expect(triggeredSkills([kw], "add a feature")).toEqual([]);
  });

  it("never fires a skill with no trigger", () => {
    expect(triggeredSkills([manual], "build an app")).toEqual([]);
  });

  it("treats an unknown `when` key as inert", () => {
    const bogus = skill("b", { when: ["not-a-predicate"], match: [] });
    expect(triggeredSkills([bogus], "build an app")).toEqual([]);
  });

  it("returns matches in input order (registry precedence preserved)", () => {
    const out = triggeredSkills([tdd, kw, manual], "build and deploy a thing").map((s) => s.name);
    expect(out).toEqual(["tdd", "kw"]);
  });

  it("preserves the historical behavior for overlapping skills without a capability", () => {
    const broad = skill("broad", { when: [], match: ["weather"] });
    const narrow = skill("narrow", { when: [], match: ["weather forecast"] });
    expect(triggeredSkills([broad, narrow], "weather forecast").map((s) => s.name)).toEqual([
      "broad",
      "narrow",
    ]);
  });

  it("selects project over global over built-in within one declared capability", () => {
    const trigger = { when: [], match: ["weather"] };
    const builtin = skill("builtin-weather", trigger, { capability: "weather-forecast" });
    const global = skill("global-weather", trigger, {
      source: "global",
      capability: "weather-forecast",
    });
    const project = skill("project-weather", trigger, {
      source: "project",
      capability: "weather-forecast",
    });
    expect(
      triggeredSkills([builtin, global, project], "weather tomorrow").map((s) => s.name),
    ).toEqual(["project-weather"]);
  });

  it("uses input order as the deterministic tie-breaker within one scope", () => {
    const trigger = { when: [], match: ["weather"] };
    const alpha = skill("alpha", trigger, { source: "global", capability: "weather-forecast" });
    const beta = skill("beta", trigger, { source: "global", capability: "weather-forecast" });
    expect(triggeredSkills([alpha, beta], "weather").map((s) => s.name)).toEqual(["alpha"]);
  });

  it("allows an explicit composable skill to accompany the capability winner", () => {
    const trigger = { when: [], match: ["weather"] };
    const global = skill("global-weather", trigger, {
      source: "global",
      capability: "weather-forecast",
      compose: true,
    });
    const project = skill("project-weather", trigger, {
      source: "project",
      capability: "weather-forecast",
    });
    expect(triggeredSkills([global, project], "weather").map((s) => s.name)).toEqual([
      "global-weather",
      "project-weather",
    ]);
  });

  it("keeps every matching capability member when the winner is composable", () => {
    const trigger = { when: [], match: ["weather"] };
    const global = skill("global-weather", trigger, {
      source: "global",
      capability: "weather-forecast",
    });
    const project = skill("project-weather", trigger, {
      source: "project",
      capability: "weather-forecast",
      compose: true,
    });
    expect(triggeredSkills([global, project], "weather").map((s) => s.name)).toEqual([
      "global-weather",
      "project-weather",
    ]);
  });
});
