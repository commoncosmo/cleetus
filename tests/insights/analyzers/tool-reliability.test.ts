import { expect, test } from "bun:test";
import { analyzeToolReliability } from "../../../src/insights/analyzers/tool-reliability";
import type { Trajectory } from "../../../src/insights/trajectory";

function traj(toolCalls: Trajectory["toolCalls"]): Trajectory {
  return {
    sessionId: "s",
    startTs: 0,
    endTs: 0,
    userInput: "",
    taskClass: "conversation",
    modelCalls: [],
    toolCalls,
    permissions: [],
    loopCount: 0,
    outcome: "ok",
    incomplete: false,
  };
}

test("aggregates calls, failures, rate, and capped/sorted top errors", () => {
  const t = [
    traj([
      { name: "bash", ok: false, errorMessage: "boom", durationMs: 1 },
      { name: "bash", ok: false, errorMessage: "boom", durationMs: 1 },
      { name: "bash", ok: false, errorMessage: "nope", durationMs: 1 },
      { name: "bash", ok: true, durationMs: 1 },
      { name: "read_file", ok: true, durationMs: 1 },
    ]),
  ];
  const r = analyzeToolReliability(t);
  expect(r.tools[0]).toEqual({
    tool: "bash",
    calls: 4,
    failures: 3,
    failureRate: 0.75,
    topErrors: [
      { message: "boom", count: 2 },
      { message: "nope", count: 1 },
    ],
  });
  expect(r.tools[1]!.tool).toBe("read_file");
});

test("empty input yields no tools", () => {
  expect(analyzeToolReliability([]).tools).toEqual([]);
});

test("caps topErrors at TOP_ERRORS, keeping the most frequent", () => {
  const r = analyzeToolReliability([
    traj([
      { name: "write_file", ok: false, errorMessage: "e1", durationMs: 1 },
      { name: "write_file", ok: false, errorMessage: "e1", durationMs: 1 },
      { name: "write_file", ok: false, errorMessage: "e2", durationMs: 1 },
      { name: "write_file", ok: false, errorMessage: "e3", durationMs: 1 },
      { name: "write_file", ok: false, errorMessage: "e4", durationMs: 1 },
    ]),
  ]);
  expect(r.tools[0]!.topErrors).toHaveLength(3);
  expect(r.tools[0]!.topErrors[0]).toEqual({ message: "e1", count: 2 });
  expect(r.tools[0]!.topErrors.map((e) => e.message)).not.toContain("e4");
});

test("breaks failure-count ties by call volume (desc)", () => {
  const r = analyzeToolReliability([
    traj([
      // toolA: 1 failure, 3 calls
      { name: "toolA", ok: false, errorMessage: "x", durationMs: 1 },
      { name: "toolA", ok: true, durationMs: 1 },
      { name: "toolA", ok: true, durationMs: 1 },
      // toolB: 1 failure, 1 call
      { name: "toolB", ok: false, errorMessage: "y", durationMs: 1 },
    ]),
  ]);
  expect(r.tools.map((t) => t.tool)).toEqual(["toolA", "toolB"]);
});

test("breaks equal failures+calls ties by tool name", () => {
  const r = analyzeToolReliability([
    traj([
      { name: "zeta", ok: true, durationMs: 1 },
      { name: "alpha", ok: true, durationMs: 1 },
    ]),
  ]);
  expect(r.tools.map((t) => t.tool)).toEqual(["alpha", "zeta"]);
});
