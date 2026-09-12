import type { Skill } from "./types";

export interface SkillRegistry {
  /** All skills, sorted by name. */
  list(): Skill[];
  /** Look up a skill by exact name. */
  get(name: string): Skill | undefined;
  /** Resolve an arg to a skill name: exact match, then unambiguous prefix, else null. */
  resolveName(arg: string): string | null;
  /** Add or replace a skill in the live registry (used after an explicitly saved learned skill). */
  upsert(skill: Skill): void;
}

function triggerOverlap(a: Skill, b: Skill): boolean {
  if (!a.trigger || !b.trigger) return false;
  const aWhen = new Set(a.trigger.when.map((value) => value.toLowerCase()));
  if (b.trigger.when.some((value) => aWhen.has(value.toLowerCase()))) return true;
  return a.trigger.match.some((left) =>
    b.trigger!.match.some((right) => {
      const l = left.toLowerCase();
      const r = right.toLowerCase();
      return l.includes(r) || r.includes(l);
    }),
  );
}

function skillLabel(skill: Skill): string {
  return skill.filePath ? `${skill.source} ${skill.filePath}` : skill.source;
}

/**
 * Diagnostics for deterministic shadowing and declared capability overlap. These are warnings,
 * not validation failures: compatible third-party SKILL.md files continue to load leniently.
 */
export function skillRegistryWarnings(builtins: Skill[], discovered: Skill[]): string[] {
  const warnings: string[] = [];
  const all = [...builtins, ...discovered];
  const byName = new Map<string, Skill[]>();
  for (const skill of all) {
    const group = byName.get(skill.name) ?? [];
    group.push(skill);
    byName.set(skill.name, group);
  }
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const winner = [
      ...group.filter((skill) => skill.source === "built-in"),
      ...group.filter((skill) => skill.source === "global"),
      ...group.filter((skill) => skill.source === "project"),
    ].at(-1)!;
    warnings.push(
      `skill '${name}' from ${skillLabel(winner)} shadows ${group
        .filter((skill) => skill !== winner)
        .map(skillLabel)
        .join(", ")}`,
    );
  }

  const active = buildSkillRegistry(builtins, discovered).list();
  for (let i = 0; i < active.length; i++) {
    const left = active[i]!;
    if (!left.capability || !left.trigger) continue;
    for (let j = i + 1; j < active.length; j++) {
      const right = active[j]!;
      if (
        right.capability !== left.capability ||
        !triggerOverlap(left, right) ||
        left.compose ||
        right.compose
      ) {
        continue;
      }
      warnings.push(
        `skills '${left.name}' and '${right.name}' share capability '${left.capability}' and overlapping auto-triggers; only the highest-precedence match will be injected`,
      );
    }
  }
  return warnings;
}

/**
 * Merge built-in and discovered skills. Precedence by name: project > global > built-in
 * (last write wins, so we set built-ins, then globals, then projects).
 */
export function buildSkillRegistry(builtins: Skill[], discovered: Skill[]): SkillRegistry {
  const byName = new Map<string, Skill>();
  const ordered = [
    ...builtins,
    ...discovered.filter((s) => s.source === "global"),
    ...discovered.filter((s) => s.source === "project"),
  ];
  for (const s of ordered) byName.set(s.name, s);

  return {
    list: () => [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    get: (name) => byName.get(name),
    upsert: (skill) => {
      byName.set(skill.name, skill);
    },
    resolveName(arg) {
      const a = arg.trim().toLowerCase();
      if (!a) return null;
      const names = [...byName.keys()];
      const exact = names.find((n) => n.toLowerCase() === a);
      if (exact) return exact;
      const prefixed = names.filter((n) => n.toLowerCase().startsWith(a));
      return prefixed.length === 1 ? prefixed[0]! : null;
    },
  };
}
