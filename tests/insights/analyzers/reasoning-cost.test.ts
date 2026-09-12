import { expect, test } from "bun:test";
import type { TaskClass } from "../../../src/agent/coding-task";
import { analyzeReasoningCost } from "../../../src/insights/analyzers/reasoning-cost";
import type { ModelCallSummary, Outcome, Trajectory } from "../../../src/insights/trajectory";

function traj(
  taskClass: TaskClass,
  modelCalls: ModelCallSummary[],
  outcome: Outcome = "ok",
): Trajectory {
  return {
    sessionId: "s",
    startTs: 0,
    endTs: 0,
    userInput: "",
    taskClass,
    modelCalls,
    toolCalls: [],
    permissions: [],
    loopCount: 0,
    outcome,
    incomplete: false,
  };
}

function call(
  tier: ModelCallSummary["tier"],
  reasoningChars: number,
  output?: number,
): ModelCallSummary {
  return {
    tier,
    reason: "smart: small",
    finishReason: "stop",
    usage: output === undefined ? undefined : { input: 1, output },
    reasoningChars,
  };
}

test("buckets calls by task class and estimates reasoning tokens at 4 chars per token", () => {
  const r = analyzeReasoningCost([
    traj("broad_code", [call("small", 400, 200), call("small", 0, 100)]),
    traj("conversation", [call("small", 40, 20)]),
  ]);
  const bc = r.byTaskClass.broad_code;
  expect(bc.calls).toBe(2);
  expect(bc.callsWithReasoning).toBe(1);
  expect(bc.reasoningChars).toBe(400);
  expect(bc.estReasoningTokens).toBe(100);
  expect(bc.outputTokens).toBe(300);
  expect(bc.reasoningShare).toBeCloseTo(100 / 300);
  expect(r.byTaskClass.conversation.calls).toBe(1);
  expect(r.byTaskClass.conversation.estReasoningTokens).toBe(10);
});

test("every task class is present even with no calls", () => {
  const r = analyzeReasoningCost([]);
  const classes: TaskClass[] = [
    "conversation",
    "retrieval",
    "artifact",
    "focused_code",
    "broad_code",
  ];
  for (const c of classes) {
    expect(r.byTaskClass[c].calls).toBe(0);
    expect(r.byTaskClass[c].outputTokens).toBeNull();
    expect(r.byTaskClass[c].reasoningShare).toBeNull();
  }
});

test("share is null when no call in the bucket reported output usage", () => {
  const r = analyzeReasoningCost([traj("retrieval", [call("small", 80)])]);
  expect(r.byTaskClass.retrieval.estReasoningTokens).toBe(20);
  expect(r.byTaskClass.retrieval.outputTokens).toBeNull();
  expect(r.byTaskClass.retrieval.reasoningShare).toBeNull();
});

test("share is clamped to 1 when the estimate exceeds reported output", () => {
  // A 4-chars/token guess can overshoot on a dense tokenizer; never report >100%.
  const r = analyzeReasoningCost([traj("focused_code", [call("small", 1000, 100)])]);
  expect(r.byTaskClass.focused_code.reasoningShare).toBe(1);
});

test("splits each class by tier", () => {
  const r = analyzeReasoningCost([
    traj("broad_code", [call("small", 400, 200), call("large", 100, 400), call(null, 8, 8)]),
  ]);
  const { tiers } = r.byTaskClass.broad_code;
  expect(tiers.small.calls).toBe(1);
  expect(tiers.small.reasoningShare).toBeCloseTo(0.5);
  expect(tiers.large.calls).toBe(1);
  expect(tiers.large.reasoningShare).toBeCloseTo(25 / 400);
  expect(tiers.untiered.calls).toBe(1);
  expect(tiers.untiered.reasoningShare).toBeCloseTo(0.25);
});

test("counts turns and ok turns per class", () => {
  const r = analyzeReasoningCost([
    traj("artifact", [call("small", 0, 10)], "ok"),
    traj("artifact", [call("small", 0, 10)], "error"),
    traj("artifact", [], "loop_limit"),
  ]);
  expect(r.byTaskClass.artifact.turns).toBe(3);
  expect(r.byTaskClass.artifact.okTurns).toBe(1);
});

test("hasReasoning is true only when some call carried reasoning text", () => {
  expect(analyzeReasoningCost([traj("conversation", [call("small", 0, 5)])]).hasReasoning).toBe(
    false,
  );
  expect(analyzeReasoningCost([traj("conversation", [call("small", 3, 5)])]).hasReasoning).toBe(
    true,
  );
});
