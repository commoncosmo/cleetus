import { expect, test } from "bun:test";
import { analyzeReasoningCost } from "../../src/insights/analyzers/reasoning-cost";
import { explainReport, selectSamples } from "../../src/insights/explain";
import type { InsightsReport } from "../../src/insights/report";
import type { Trajectory } from "../../src/insights/trajectory";
import type { Provider, StreamEvent } from "../../src/providers/types";

function traj(over: Partial<Trajectory>): Trajectory {
  return {
    sessionId: "s",
    startTs: 0,
    endTs: 0,
    userInput: "",
    taskClass: "conversation",
    modelCalls: [],
    toolCalls: [],
    permissions: [],
    loopCount: 0,
    outcome: "ok",
    incomplete: false,
    ...over,
  };
}
function stubProvider(chunks: string[], captured?: { messages?: unknown }): Provider {
  return {
    listModels: async () => [],
    embed: async () => [],
    async *chat(opts): AsyncIterable<StreamEvent> {
      if (captured) captured.messages = opts.messages;
      for (const c of chunks) yield { type: "text-delta", text: c };
      yield { type: "finish", reason: "stop" };
    },
  };
}
const minimalReport: InsightsReport = {
  filter: {},
  sessionCount: 1,
  trajectoryCount: 1,
  toolReliability: { tools: [] },
  turnEfficiency: {
    totalTurns: 1,
    avgLoops: 1,
    maxLoops: 1,
    loopHistogram: { 1: 1 },
    outcomes: { ok: 1, error: 0, cancelled: 0, loop_limit: 0 },
  },
  permissionPatterns: { stats: [], suggestions: [] },
  routingCost: {
    tierUsage: { small: 1, large: 0, untiered: 0 },
    escalations: 0,
    escalationsByReason: {},
    finishPasses: 0,
    totalTokens: null,
  },
  reasoningCost: analyzeReasoningCost([]),
};

test("selectSamples prefers loop_limit and failing-tool turns, capped", () => {
  const samples = selectSamples(minimalReport, [
    traj({ userInput: "clean", outcome: "ok" }),
    traj({ userInput: "looped", outcome: "loop_limit" }),
    traj({ userInput: "failed", toolCalls: [{ name: "bash", ok: false, durationMs: 1 }] }),
  ]);
  const inputs = samples.map((s) => s.userInput);
  expect(inputs).toContain("looped");
  expect(inputs).toContain("failed");
  expect(inputs).not.toContain("clean");
});

test("explainReport accumulates streamed text and includes the report in the prompt", async () => {
  const captured: { messages?: unknown } = {};
  const provider = stubProvider(["sugg", "estions"], captured);
  const out = await explainReport(minimalReport, [], provider, "test-model");
  expect(out).toBe("suggestions");
  const userMsg = (captured.messages as { role: string; content: string }[]).at(-1);
  expect(userMsg?.content).toContain("trajectoryCount");
});

test("explainReport returns empty when already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  const out = await explainReport(minimalReport, [], stubProvider(["x"]), "m", ac.signal);
  expect(out).toBe("");
});
