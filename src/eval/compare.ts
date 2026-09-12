import type { CandidateScorecard, Comparison, RunScore } from "./types";

const BASELINE_NAME = "baseline";

/** Aggregate run scores per candidate and rank them (best first). */
export function compare(scores: RunScore[]): Comparison {
  const byCandidate = new Map<string, RunScore[]>();
  for (const s of scores) {
    const list = byCandidate.get(s.candidate) ?? [];
    list.push(s);
    byCandidate.set(s.candidate, list);
  }

  const cards: CandidateScorecard[] = [...byCandidate.entries()].map(([candidate, runs]) => {
    const passed = runs.filter((r) => r.passed).length;
    return {
      candidate,
      scenariosRun: runs.length,
      passed,
      passRate: runs.length > 0 ? passed / runs.length : 0,
      totalToolFailures: runs.reduce((n, r) => n + r.toolFailures, 0),
      totalLoops: runs.reduce((n, r) => n + r.loops, 0),
      totalTokens: runs.reduce((n, r) => n + r.tokens, 0),
      totalElapsedMs: runs.reduce((n, r) => n + r.elapsedMs, 0),
      runs,
    };
  });

  cards.sort(
    (a, b) =>
      b.passed - a.passed ||
      a.totalToolFailures - b.totalToolFailures ||
      a.totalLoops - b.totalLoops ||
      a.totalTokens - b.totalTokens ||
      a.candidate.localeCompare(b.candidate),
  );

  return { baseline: BASELINE_NAME, ranked: cards };
}
