import { expect, test } from "bun:test";
import { analyzeRoutingCost } from "../../../src/insights/analyzers/routing-cost";
import type { ModelCallSummary, Trajectory } from "../../../src/insights/trajectory";

// Routing-cost analysis never reads reasoningChars, so fixtures may omit it.
function traj(modelCalls: Omit<ModelCallSummary, "reasoningChars">[]): Trajectory {
  return {
    sessionId: "s",
    startTs: 0,
    endTs: 0,
    userInput: "",
    taskClass: "conversation",
    modelCalls: modelCalls.map((m) => ({ ...m, reasoningChars: 0 })),
    toolCalls: [],
    permissions: [],
    loopCount: 0,
    outcome: "ok",
    incomplete: false,
  };
}

test("counts tiers, escalations, finish passes, and sums tokens", () => {
  const r = analyzeRoutingCost([
    traj([
      {
        tier: "small",
        reason: "smart: small",
        finishReason: "tool-calls",
        usage: { input: 10, output: 5 },
      },
      {
        tier: "large",
        reason: "smart: escalated (loop_depth>=3)",
        finishReason: "stop",
        usage: { input: 20, output: 8 },
      },
      {
        tier: "large",
        reason: "speed: finish",
        finishReason: "stop",
        usage: { input: 4, output: 2 },
      },
      { tier: null, reason: "manual", finishReason: "stop" },
    ]),
  ]);
  expect(r.tierUsage).toEqual({ small: 1, large: 2, untiered: 1 });
  expect(r.escalations).toBe(1);
  expect(r.finishPasses).toBe(1);
  expect(r.totalTokens).toEqual({ input: 34, output: 15 });
});

test("breaks escalations down by cause, splitting multi-cause reasons", () => {
  const r = analyzeRoutingCost([
    traj([
      { tier: "small", reason: "smart: small", finishReason: "stop" },
      {
        tier: "large",
        reason: "smart: escalated (broad_code)",
        finishReason: "stop",
      },
      {
        tier: "large",
        reason: "smart: escalated (consecutive_tool_failures>=3, retrieval_stalled)",
        finishReason: "stop",
      },
      {
        tier: "large",
        reason: "smart: escalated (small_reasoned_empty)",
        finishReason: "stop",
      },
      { tier: "large", reason: "speed: finish", finishReason: "stop" },
    ]),
  ]);
  expect(r.escalations).toBe(3);
  expect(r.escalationsByReason).toEqual({
    broad_code: 1,
    "consecutive_tool_failures>=3": 1,
    retrieval_stalled: 1,
    small_reasoned_empty: 1,
  });
});

test("totalTokens is null when no usage is reported", () => {
  const r = analyzeRoutingCost([
    traj([{ tier: "small", reason: "smart: small", finishReason: "stop" }]),
  ]);
  expect(r.totalTokens).toBeNull();
});

test("partial usage (input only) contributes with output defaulting to 0", () => {
  const r = analyzeRoutingCost([
    traj([{ tier: "small", reason: "smart: small", finishReason: "stop", usage: { input: 7 } }]),
  ]);
  expect(r.totalTokens).toEqual({ input: 7, output: 0 });
});
