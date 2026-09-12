import { ALWAYS_ALLOW_SUGGEST_THRESHOLD } from "../constants";
import type { Trajectory } from "../trajectory";

export interface PermStat {
  tool: string;
  argsSummary: string;
  allows: number;
  denies: number;
}
export interface PolicySuggestion {
  tool: string;
  argsSummary: string;
  allows: number;
  reason: string;
}
export interface PermissionPatterns {
  stats: PermStat[];
  suggestions: PolicySuggestion[];
}

// Null byte: tool names are identifiers, so this can never collide with a real (tool,args) boundary.
const SEP = "\0";

export function analyzePermissionPatterns(trajectories: Trajectory[]): PermissionPatterns {
  const map = new Map<string, PermStat>();
  for (const t of trajectories) {
    for (const p of t.permissions) {
      const key = `${p.tool}${SEP}${p.argsSummary}`;
      let stat = map.get(key);
      if (!stat) {
        stat = { tool: p.tool, argsSummary: p.argsSummary, allows: 0, denies: 0 };
        map.set(key, stat);
      }
      if (p.decision === "allow") stat.allows++;
      else stat.denies++;
    }
  }

  const stats = [...map.values()].sort(
    (a, b) => a.tool.localeCompare(b.tool) || a.argsSummary.localeCompare(b.argsSummary),
  );
  const suggestions: PolicySuggestion[] = stats
    .filter((s) => s.denies === 0 && s.allows >= ALWAYS_ALLOW_SUGGEST_THRESHOLD)
    .map((s) => ({
      tool: s.tool,
      argsSummary: s.argsSummary,
      allows: s.allows,
      reason: `allowed ${s.allows}x, never denied — candidate for project allowlist`,
    }));

  return { stats, suggestions };
}
