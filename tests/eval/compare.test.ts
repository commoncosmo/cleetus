import { expect, test } from "bun:test";
import { compare } from "../../src/eval/compare";
import type { RunScore } from "../../src/eval/types";

function rs(over: Partial<RunScore>): RunScore {
  return {
    candidate: "baseline",
    scenario: "s1",
    passed: true,
    metrics: {} as RunScore["metrics"],
    toolFailures: 0,
    loops: 1,
    tokens: 100,
    elapsedMs: 10,
    ...over,
  };
}

test("aggregates per candidate and ranks pass-count first", () => {
  const c = compare([
    rs({ candidate: "baseline", scenario: "s1", passed: true }),
    rs({ candidate: "baseline", scenario: "s2", passed: false }),
    rs({ candidate: "terse", scenario: "s1", passed: true }),
    rs({ candidate: "terse", scenario: "s2", passed: true }),
  ]);
  expect(c.baseline).toBe("baseline");
  expect(c.ranked.map((s) => s.candidate)).toEqual(["terse", "baseline"]); // 2 passes beats 1
  const baseline = c.ranked.find((s) => s.candidate === "baseline")!;
  expect(baseline.scenariosRun).toBe(2);
  expect(baseline.passed).toBe(1);
  expect(baseline.passRate).toBe(0.5);
});

test("ties on passes break by fewer tool failures, then loops, then tokens, then name", () => {
  const c = compare([
    rs({ candidate: "b", passed: true, toolFailures: 2, loops: 5, tokens: 100 }),
    rs({ candidate: "a", passed: true, toolFailures: 2, loops: 3, tokens: 100 }), // fewer loops → ranks above b
    rs({ candidate: "c", passed: true, toolFailures: 0, loops: 9, tokens: 999 }), // fewest failures → first
  ]);
  expect(c.ranked.map((s) => s.candidate)).toEqual(["c", "a", "b"]);
});

test("ties broken by tokens before name (fewer tokens wins)", () => {
  const c = compare([
    rs({ candidate: "a", passed: true, toolFailures: 0, loops: 1, tokens: 200 }),
    rs({ candidate: "b", passed: true, toolFailures: 0, loops: 1, tokens: 100 }),
  ]);
  expect(c.ranked.map((s) => s.candidate)).toEqual(["b", "a"]);
});

test("all-equal metrics break by candidate name asc", () => {
  const c = compare([
    rs({ candidate: "z", passed: true, toolFailures: 0, loops: 1, tokens: 50 }),
    rs({ candidate: "a", passed: true, toolFailures: 0, loops: 1, tokens: 50 }),
  ]);
  expect(c.ranked.map((s) => s.candidate)).toEqual(["a", "z"]);
});
