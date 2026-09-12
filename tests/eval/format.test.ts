import { expect, test } from "bun:test";
import { formatComparison, toJson } from "../../src/eval/format";
import type { CandidateScorecard, Comparison } from "../../src/eval/types";

function card(over: Partial<CandidateScorecard>): CandidateScorecard {
  return {
    candidate: "baseline",
    scenariosRun: 2,
    passed: 1,
    passRate: 0.5,
    totalToolFailures: 3,
    totalLoops: 6,
    totalTokens: 500,
    totalElapsedMs: 100,
    runs: [],
    ...over,
  };
}

test("renders a row per candidate, marks the winner, shows delta vs baseline", () => {
  const comparison: Comparison = {
    baseline: "baseline",
    ranked: [
      card({ candidate: "terse", passed: 2, totalToolFailures: 1 }),
      card({ candidate: "baseline", passed: 1, totalToolFailures: 3 }),
    ],
  };
  const out = formatComparison(comparison);
  expect(out).toContain("terse");
  expect(out).toContain("baseline");
  expect(out).toContain("2/2"); // passed/total for terse
  expect(out.toLowerCase()).toContain("winner");
  expect(out).toContain("-2"); // terse has 2 fewer tool failures than baseline (signed delta)
});

test("empty ranking prints a no-runs message", () => {
  expect(formatComparison({ baseline: "baseline", ranked: [] })).toBe("no eval runs");
});

test("no delta lines when the baseline is absent from ranked", () => {
  const comparison: Comparison = {
    baseline: "baseline",
    ranked: [card({ candidate: "terse", passed: 2, totalToolFailures: 1 })],
  };
  const out = formatComparison(comparison);
  expect(out).toContain("terse");
  expect(out).not.toContain("Δ");
});

test("toJson round-trips", () => {
  const comparison: Comparison = { baseline: "baseline", ranked: [card({})] };
  expect(JSON.parse(toJson(comparison))).toEqual(comparison);
});
