import { expect, test } from "bun:test";
import { analyzeReasoningCost } from "../../src/insights/analyzers/reasoning-cost";
import { formatReport, toJson } from "../../src/insights/format";
import type { InsightsReport } from "../../src/insights/report";
import type { ModelCallSummary, Trajectory } from "../../src/insights/trajectory";

function emptyReport(): InsightsReport {
  return {
    filter: {},
    sessionCount: 0,
    trajectoryCount: 0,
    toolReliability: { tools: [] },
    turnEfficiency: {
      totalTurns: 0,
      avgLoops: 0,
      maxLoops: 0,
      loopHistogram: {},
      outcomes: { ok: 0, error: 0, cancelled: 0, loop_limit: 0 },
    },
    permissionPatterns: { stats: [], suggestions: [] },
    routingCost: {
      tierUsage: { small: 0, large: 0, untiered: 0 },
      escalations: 0,
      escalationsByReason: {},
      finishPasses: 0,
      totalTokens: null,
    },
    reasoningCost: analyzeReasoningCost([]),
  };
}

function traj(taskClass: Trajectory["taskClass"], modelCalls: ModelCallSummary[]): Trajectory {
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
    outcome: "ok",
    incomplete: false,
  };
}

test("empty report prints the no-data message", () => {
  expect(formatReport(emptyReport())).toBe("no sessions recorded yet");
});

test("non-empty report includes all four section headings", () => {
  const r = emptyReport();
  r.trajectoryCount = 3;
  r.sessionCount = 1;
  r.toolReliability.tools = [
    {
      tool: "bash",
      calls: 4,
      failures: 1,
      failureRate: 0.25,
      topErrors: [{ message: "boom", count: 1 }],
    },
  ];
  r.permissionPatterns.suggestions = [
    {
      tool: "bash",
      argsSummary: "bash: git status",
      allows: 6,
      reason: "allowed 6x, never denied — candidate for project allowlist",
    },
  ];
  const out = formatReport(r);
  expect(out).toContain("Tool reliability");
  expect(out).toContain("Turn efficiency");
  expect(out).toContain("Permission patterns");
  expect(out).toContain("Routing & cost");
  expect(out).toContain("bash");
  expect(out).toContain("candidate for project allowlist");
  expect(out).toContain("3 turns"); // totalTurns rendered
  expect(out).toContain("avg 0.0 loops"); // avgLoops rendered (toFixed(1))
  expect(out).toContain("tiers: small=0"); // routing & cost section rendered
  expect(out).toContain("tokens: not reported"); // null totalTokens path rendered
});

test("shows an escalation-cause breakdown when escalations occurred", () => {
  const r = emptyReport();
  r.trajectoryCount = 1;
  r.routingCost.escalations = 2;
  r.routingCost.escalationsByReason = { broad_code: 1, retrieval_stalled: 1 };
  const out = formatReport(r);
  expect(out).toContain("by cause: broad_code=1, retrieval_stalled=1");
});

test("omits the escalation-cause line when there are no escalations", () => {
  const r = emptyReport();
  r.trajectoryCount = 1;
  const out = formatReport(r);
  expect(out).not.toContain("by cause:");
});

test("renders a reasoning section per task class with the estimated thinking share", () => {
  const r = emptyReport();
  r.trajectoryCount = 1;
  r.reasoningCost = analyzeReasoningCost([
    traj("broad_code", [
      {
        tier: "small",
        reason: "smart: small",
        finishReason: "stop",
        usage: { input: 1, output: 200 },
        reasoningChars: 400,
      },
      {
        tier: "large",
        reason: "smart: escalated (broad_code)",
        finishReason: "stop",
        usage: { input: 1, output: 100 },
        reasoningChars: 0,
      },
    ]),
  ]);
  const out = formatReport(r);
  expect(out).toContain("## Reasoning");
  expect(out).toContain("broad_code: 2 calls (1 thought)");
  expect(out).toContain("~100 tok ≈ 33% of output");
  expect(out).toContain("small 50% / large 0%");
  expect(out).toContain("1 turn (1 ok)");
  expect(out).not.toContain("conversation:"); // classes with no calls are skipped
});

test("omits the reasoning section entirely when no call carried reasoning text", () => {
  const r = emptyReport();
  r.trajectoryCount = 1;
  r.reasoningCost = analyzeReasoningCost([
    traj("conversation", [
      {
        tier: "small",
        reason: "smart: small",
        finishReason: "stop",
        usage: { input: 1, output: 20 },
        reasoningChars: 0,
      },
    ]),
  ]);
  expect(formatReport(r)).not.toContain("## Reasoning");
});

test("toJson round-trips the report", () => {
  const r = emptyReport();
  expect(JSON.parse(toJson(r))).toEqual(r);
});
