import { expect, test } from "bun:test";
import {
  orchestrationSkillDeps,
  renderDecomposeGuidance,
  renderWorkerSeed,
  skillsForDecompose,
  skillsForExecute,
} from "../../src/skills/orchestration";
import type { Skill } from "../../src/skills/types";

function skill(name: string, body: string, match: string[] = []): Skill {
  return { name, description: "d", source: "built-in", body, trigger: { when: [], match } };
}

test("resolvers are identity in v1", () => {
  const arr = [skill("a", "A"), skill("b", "B")];
  expect(skillsForDecompose(arr)).toEqual(arr);
  expect(skillsForExecute(arr)).toEqual(arr);
});

const mk = (name: string, scope?: "decompose" | "execute" | "both"): Skill => ({
  name,
  description: "",
  source: "built-in",
  body: "b",
  ...(scope ? { scope } : {}),
});

test("skillsForDecompose keeps decompose+both, drops execute", () => {
  const skills = [mk("d", "decompose"), mk("e", "execute"), mk("b", "both"), mk("u")];
  expect(skillsForDecompose(skills).map((s) => s.name)).toEqual(["d", "b", "u"]);
});

test("skillsForExecute keeps execute+both, drops decompose", () => {
  const skills = [mk("d", "decompose"), mk("e", "execute"), mk("b", "both"), mk("u")];
  expect(skillsForExecute(skills).map((s) => s.name)).toEqual(["e", "b", "u"]);
});

test("renderDecomposeGuidance frames for a planner and includes each skill body", () => {
  const out = renderDecomposeGuidance([skill("test-driven-development", "RED-GREEN-REFACTOR")]);
  expect(out).toContain("STRUCTURE"); // planner framing, not "applies to this request"
  expect(out).toContain("### test-driven-development");
  expect(out).toContain("RED-GREEN-REFACTOR");
});

test("renderDecomposeGuidance is empty string for no skills", () => {
  expect(renderDecomposeGuidance([])).toBe("");
});

test("renderWorkerSeed renders execution-framed reminders", () => {
  const seed = renderWorkerSeed([skill("tdd", "BODY")]);
  expect(seed).toHaveLength(1);
  expect(seed[0]).toContain('The "tdd" skill applies');
  expect(seed[0]).toContain("BODY");
});

test("renderWorkerSeed is empty array for no skills", () => {
  expect(renderWorkerSeed([])).toEqual([]);
});

test("orchestrationSkillDeps returns no deps when disabled", () => {
  const deps = orchestrationSkillDeps(() => [skill("tdd", "BODY", ["build"])], false);
  expect(deps.decomposeGuidance).toBeUndefined();
  expect(deps.workerSkillSeed).toBeUndefined();
});

test("orchestrationSkillDeps closures evaluate triggers against the input when enabled", () => {
  const deps = orchestrationSkillDeps(() => [skill("tdd", "BODY", ["build"])], true);
  // Triggers on "build", absent otherwise.
  expect(deps.decomposeGuidance!("build a thing")).toContain("BODY");
  expect(deps.decomposeGuidance!("show me a list")).toBe("");
  expect(deps.workerSkillSeed!("build a thing")[0]).toContain("BODY");
  expect(deps.workerSkillSeed!("show me a list")).toEqual([]);
});
