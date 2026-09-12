import { expect, test } from "bun:test";
import { analyzeTurnEfficiency } from "../../../src/insights/analyzers/turn-efficiency";
import type { Outcome, Trajectory } from "../../../src/insights/trajectory";

function traj(loopCount: number, outcome: Outcome, incomplete = false): Trajectory {
  return {
    sessionId: "s",
    startTs: 0,
    endTs: 0,
    userInput: "",
    taskClass: "conversation",
    modelCalls: [],
    toolCalls: [],
    permissions: [],
    loopCount,
    outcome,
    incomplete,
  };
}

test("computes avg/max/histogram/outcomes over classified turns only", () => {
  const r = analyzeTurnEfficiency([
    traj(1, "ok"),
    traj(3, "ok"),
    traj(2, "error"),
    traj(9, "ok", true), // incomplete — excluded
  ]);
  expect(r.totalTurns).toBe(3);
  expect(r.avgLoops).toBe(2); // (1+3+2)/3
  expect(r.maxLoops).toBe(3);
  expect(r.loopHistogram).toEqual({ 1: 1, 2: 1, 3: 1 });
  expect(r.outcomes).toEqual({ ok: 2, error: 1, cancelled: 0, loop_limit: 0 });
});

test("empty input is all zeros", () => {
  const r = analyzeTurnEfficiency([]);
  expect(r).toEqual({
    totalTurns: 0,
    avgLoops: 0,
    maxLoops: 0,
    loopHistogram: {},
    outcomes: { ok: 0, error: 0, cancelled: 0, loop_limit: 0 },
  });
});

test("zero-loop classified turn contributes correctly", () => {
  const r = analyzeTurnEfficiency([traj(0, "ok")]);
  expect(r.totalTurns).toBe(1);
  expect(r.avgLoops).toBe(0);
  expect(r.maxLoops).toBe(0);
  expect(r.loopHistogram).toEqual({ 0: 1 });
  expect(r.outcomes).toEqual({ ok: 1, error: 0, cancelled: 0, loop_limit: 0 });
});

test("loop_limit outcome is counted", () => {
  const r = analyzeTurnEfficiency([traj(10, "loop_limit")]);
  expect(r.outcomes.loop_limit).toBe(1);
  expect(r.outcomes.ok).toBe(0);
});
