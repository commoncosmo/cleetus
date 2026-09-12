import type { CandidateScorecard, Comparison } from "../eval/types";

export interface GateResult {
  winner: CandidateScorecard | null;
  reason: string;
}

/** Pure: pick the top candidate iff it beats baseline with no regression. */
export function selectWinner(
  comparison: Comparison,
  baselineName = comparison.baseline,
): GateResult {
  const baseline = comparison.ranked.find((c) => c.candidate === baselineName);
  if (!baseline) return { winner: null, reason: "baseline not found in comparison" };

  const top = comparison.ranked[0];
  if (!top || top.candidate === baselineName) {
    return { winner: null, reason: "baseline was best — no candidate beat it" };
  }

  // No regression. `compare()` sorts passes descending, so this fires only with a
  // custom-ordered Comparison; kept to stay correct regardless of how `ranked` was built.
  if (top.passed < baseline.passed) {
    return { winner: null, reason: "best candidate regressed on passes" };
  }

  if (top.passed > baseline.passed) {
    return {
      winner: top,
      reason: `passed ${top.passed}/${top.scenariosRun} vs baseline ${baseline.passed}/${baseline.scenariosRun}`,
    };
  }

  // Equal passes: require a strict improvement on a real metric (not a name tiebreak).
  if (top.totalToolFailures < baseline.totalToolFailures) {
    return {
      winner: top,
      reason: `tied passes (${top.passed}/${top.scenariosRun}), ${baseline.totalToolFailures - top.totalToolFailures} fewer tool failures`,
    };
  }
  if (
    top.totalToolFailures === baseline.totalToolFailures &&
    top.totalLoops < baseline.totalLoops
  ) {
    return {
      winner: top,
      reason: `tied passes (${top.passed}/${top.scenariosRun}), ${baseline.totalLoops - top.totalLoops} fewer loops`,
    };
  }
  if (
    top.totalToolFailures === baseline.totalToolFailures &&
    top.totalLoops === baseline.totalLoops &&
    top.totalTokens < baseline.totalTokens
  ) {
    return {
      winner: top,
      reason: `tied passes (${top.passed}/${top.scenariosRun}), ${baseline.totalTokens - top.totalTokens} fewer tokens`,
    };
  }

  return { winner: null, reason: "best candidate did not strictly beat baseline" };
}
