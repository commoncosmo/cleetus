import { composeSkillBody, renderSkillReminder } from "./compose";
import { triggeredSkills } from "./trigger";
import type { Skill } from "./types";

/** decompose | both (absent ⇒ both). */
const inDecompose = (s: Skill) => (s.scope ?? "both") !== "execute";
/** execute | both (absent ⇒ both). */
const inExecute = (s: Skill) => (s.scope ?? "both") !== "decompose";

export function skillsForDecompose(skills: Skill[]): Skill[] {
  return skills.filter(inDecompose);
}

export function skillsForExecute(skills: Skill[]): Skill[] {
  return skills.filter(inExecute);
}

/**
 * Decomposition-framed guidance block folded into the orchestrator's structuring system prompt.
 * Framed for a PLANNER deciding task shape (not an executor); "" when no skill applies. Pure.
 */
export function renderDecomposeGuidance(skills: Skill[]): string {
  const chosen = skillsForDecompose(skills);
  if (chosen.length === 0) return "";
  const bodies = chosen.map((s) => `### ${s.name}\n${composeSkillBody(s)}`).join("\n\n");
  return `SKILL DISCIPLINES — the following disciplines govern how you STRUCTURE the tasks. Shape the task list so each task honors them (e.g. a test-first discipline means authoring explicit write-failing-test → implement → verify tasks or steps):\n\n${bodies}`;
}

/**
 * Execution-framed advisory reminders seeded into every worker turn — reuses the same renderer
 * inline auto-invocation uses. [] when no skill applies. Pure.
 */
export function renderWorkerSeed(skills: Skill[]): string[] {
  return skillsForExecute(skills).map(renderSkillReminder);
}

/**
 * Build the two optional orchestrator deps from a live skill list. Both closures are present when
 * `enabled` (skills on + auto-invoke on), evaluating triggers against the given input; `{}` when
 * disabled so the orchestrator's prompts/turns stay byte-identical to today. Pure factory.
 */
export function orchestrationSkillDeps(
  listSkills: () => Skill[],
  enabled: boolean,
): {
  decomposeGuidance?: (input: string) => string;
  workerSkillSeed?: (input: string) => string[];
} {
  if (!enabled) return {};
  return {
    decomposeGuidance: (input) => renderDecomposeGuidance(triggeredSkills(listSkills(), input)),
    workerSkillSeed: (input) => renderWorkerSeed(triggeredSkills(listSkills(), input)),
  };
}
