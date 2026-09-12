import { isCodingTask } from "../agent/coding-task";
import type { Skill } from "./types";

/** Closed, cleetus-owned predicates a skill can name in `trigger.when`. v1 ships one.
 *  Extend by adding entries; an unknown key is simply never matched. */
const NAMED_PREDICATES: Record<string, (userInput: string) => boolean> = {
  "coding-task": isCodingTask,
};

function sourceRank(source: Skill["source"]): number {
  if (source === "project") return 3;
  if (source === "global") return 2;
  return 1;
}

function matchingSkills(skills: Skill[], userInput: string): Skill[] {
  const haystack = userInput.toLowerCase();
  return skills.filter((s) => {
    const t = s.trigger;
    if (!t) return false;
    if (t.when.some((key) => NAMED_PREDICATES[key]?.(userInput) ?? false)) return true;
    if (t.match.some((p) => haystack.includes(p.toLowerCase()))) return true;
    return false;
  });
}

/**
 * Return auto-trigger matches after resolving explicitly declared capability overlap.
 *
 * Skills without `metadata.cleetus-capability` retain the historical behavior and are all
 * returned. Within a declared capability, project > global > built-in; ties preserve input
 * order. The winner is returned by default. A composable winner keeps every matching member,
 * while a non-winning `metadata.cleetus-compose: "true"` skill is included additively.
 */
export function triggeredSkills(skills: Skill[], userInput: string): Skill[] {
  const matches = matchingSkills(skills, userInput);
  const grouped = new Map<string, Skill[]>();
  for (const skill of matches) {
    if (!skill.capability) continue;
    const group = grouped.get(skill.capability) ?? [];
    group.push(skill);
    grouped.set(skill.capability, group);
  }

  const selected = new Set<Skill>(matches.filter((skill) => !skill.capability));
  for (const group of grouped.values()) {
    const winner = group.reduce((best, skill) =>
      sourceRank(skill.source) > sourceRank(best.source) ? skill : best,
    );
    if (winner.compose) {
      for (const skill of group) selected.add(skill);
      continue;
    }
    selected.add(winner);
    for (const skill of group) {
      if (skill !== winner && skill.compose) selected.add(skill);
    }
  }
  return matches.filter((skill) => selected.has(skill));
}
