import { expect, test } from "bun:test";
import type { CandidateScorecard, Comparison } from "../../src/eval/types";
import { selectWinner } from "../../src/improve/gate";

function card(over: Partial<CandidateScorecard>): CandidateScorecard {
  return {
    candidate: "baseline",
    scenariosRun: 3,
    passed: 2,
    passRate: 2 / 3,
    totalToolFailures: 4,
    totalLoops: 9,
    totalTokens: 900,
    totalElapsedMs: 100,
    runs: [],
    ...over,
  };
}
function comparison(ranked: CandidateScorecard[]): Comparison {
  return { baseline: "baseline", ranked };
}

test("no winner when baseline is ranked first", () => {
  const r = selectWinner(
    comparison([
      card({ candidate: "baseline", passed: 3 }),
      card({ candidate: "mut-1", passed: 1 }),
    ]),
  );
  expect(r.winner).toBeNull();
  expect(r.reason.toLowerCase()).toContain("baseline");
});

test("winner with strictly more passes", () => {
  const r = selectWinner(
    comparison([
      card({ candidate: "mut-1", passed: 3 }),
      card({ candidate: "baseline", passed: 2 }),
    ]),
  );
  expect(r.winner?.candidate).toBe("mut-1");
  expect(r.reason).toContain("3");
});

test("tie on passes → win on fewer tool failures", () => {
  const r = selectWinner(
    comparison([
      card({ candidate: "mut-1", passed: 2, totalToolFailures: 1 }),
      card({ candidate: "baseline", passed: 2, totalToolFailures: 4 }),
    ]),
  );
  expect(r.winner?.candidate).toBe("mut-1");
  expect(r.reason.toLowerCase()).toContain("failures");
});

test("tie on passes → win on fewer loops when failures equal", () => {
  const r = selectWinner(
    comparison([
      card({ candidate: "mut-1", passed: 2, totalToolFailures: 4, totalLoops: 5 }),
      card({ candidate: "baseline", passed: 2, totalToolFailures: 4, totalLoops: 9 }),
    ]),
  );
  expect(r.winner?.candidate).toBe("mut-1");
});

test("tie on passes → win on fewer tokens when failures+loops equal", () => {
  const r = selectWinner(
    comparison([
      card({
        candidate: "mut-1",
        passed: 2,
        totalToolFailures: 4,
        totalLoops: 9,
        totalTokens: 500,
      }),
      card({
        candidate: "baseline",
        passed: 2,
        totalToolFailures: 4,
        totalLoops: 9,
        totalTokens: 900,
      }),
    ]),
  );
  expect(r.winner?.candidate).toBe("mut-1");
});

test("identical metrics (pure name tiebreak) is NOT promotable", () => {
  const r = selectWinner(
    comparison([
      card({ candidate: "aaa", passed: 2, totalToolFailures: 4, totalLoops: 9, totalTokens: 900 }),
      card({
        candidate: "baseline",
        passed: 2,
        totalToolFailures: 4,
        totalLoops: 9,
        totalTokens: 900,
      }),
    ]),
  );
  expect(r.winner).toBeNull();
});

test("missing baseline → no winner (defensive)", () => {
  const r = selectWinner(comparison([card({ candidate: "mut-1", passed: 3 })]));
  expect(r.winner).toBeNull();
  expect(r.reason.toLowerCase()).toContain("baseline");
});
