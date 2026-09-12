import type { Trajectory } from "../trajectory";

export interface RoutingCost {
  tierUsage: { small: number; large: number; untiered: number };
  escalations: number;
  /** Escalation count per individual cause, extracted from each `escalated (...)` reason's
   * comma-separated causes (a single escalating call can name more than one). */
  escalationsByReason: Record<string, number>;
  finishPasses: number;
  totalTokens: { input: number; output: number } | null;
}

const ESCALATED_CAUSES_RE = /escalated \(([^)]*)\)/;

/** Extract the individual causes named inside an `escalated (...)` reason string, e.g.
 * "smart: escalated (consecutive_tool_failures>=3, retrieval_stalled)" → both causes. Returns an
 * empty array for a non-escalation reason. */
function escalationCauses(reason: string): string[] {
  const match = ESCALATED_CAUSES_RE.exec(reason);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

export function analyzeRoutingCost(trajectories: Trajectory[]): RoutingCost {
  const tierUsage = { small: 0, large: 0, untiered: 0 };
  let escalations = 0;
  const escalationsByReason: Record<string, number> = {};
  let finishPasses = 0;
  let input = 0;
  let output = 0;
  let sawUsage = false;

  for (const t of trajectories) {
    for (const m of t.modelCalls) {
      if (m.tier === "small") tierUsage.small++;
      else if (m.tier === "large") tierUsage.large++;
      else tierUsage.untiered++;

      if (m.reason.includes("escalated")) {
        escalations++;
        for (const cause of escalationCauses(m.reason)) {
          escalationsByReason[cause] = (escalationsByReason[cause] ?? 0) + 1;
        }
      }
      if (m.reason.includes("finish")) finishPasses++;

      if (m.usage && (m.usage.input != null || m.usage.output != null)) {
        sawUsage = true;
        input += m.usage.input ?? 0;
        output += m.usage.output ?? 0;
      }
    }
  }

  return {
    tierUsage,
    escalations,
    escalationsByReason,
    finishPasses,
    totalTokens: sawUsage ? { input, output } : null,
  };
}
