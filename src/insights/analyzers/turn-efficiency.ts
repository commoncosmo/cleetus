import type { Trajectory } from "../trajectory";

export interface TurnEfficiency {
  totalTurns: number;
  avgLoops: number;
  maxLoops: number;
  loopHistogram: Record<number, number>;
  outcomes: { ok: number; error: number; cancelled: number; loop_limit: number };
}

export function analyzeTurnEfficiency(trajectories: Trajectory[]): TurnEfficiency {
  const classified = trajectories.filter((t) => !t.incomplete);
  const outcomes = { ok: 0, error: 0, cancelled: 0, loop_limit: 0 };
  const loopHistogram: Record<number, number> = {};
  let sumLoops = 0;
  let maxLoops = 0;

  for (const t of classified) {
    outcomes[t.outcome]++;
    loopHistogram[t.loopCount] = (loopHistogram[t.loopCount] ?? 0) + 1;
    sumLoops += t.loopCount;
    if (t.loopCount > maxLoops) maxLoops = t.loopCount;
  }

  return {
    totalTurns: classified.length,
    avgLoops: classified.length > 0 ? sumLoops / classified.length : 0,
    maxLoops,
    loopHistogram,
    outcomes,
  };
}
