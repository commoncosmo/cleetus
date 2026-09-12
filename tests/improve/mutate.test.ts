import { expect, test } from "bun:test";
import { type MutateDeps, focusHints, proposeCandidates } from "../../src/improve/mutate";
import { analyzeReasoningCost } from "../../src/insights/analyzers/reasoning-cost";
import type { InsightsReport } from "../../src/insights/report";
import type { Provider, StreamEvent } from "../../src/providers/types";

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

function scriptedMutator(texts: string[]): Provider {
  let i = 0;
  return {
    listModels: async () => [],
    embed: async () => [],
    async *chat(): AsyncIterable<StreamEvent> {
      const t = texts[i++] ?? "";
      if (t) yield { type: "text-delta", text: t };
      yield { type: "finish", reason: "stop" };
    },
  };
}

function deps(over: Partial<MutateDeps>): MutateDeps {
  return {
    baseInstructions: "Be quick.",
    globalContext: "",
    memoriesContext: "",
    report: emptyReport(),
    samples: [],
    provider: scriptedMutator([]),
    model: "m",
    count: 4,
    ...over,
  };
}

test("focusHints derives weakness-focused hints from the report", () => {
  const r = emptyReport();
  r.toolReliability.tools = [
    { tool: "bash", calls: 5, failures: 2, failureRate: 0.4, topErrors: [] },
  ];
  r.turnEfficiency.outcomes.loop_limit = 1;
  const hints = focusHints(r);
  expect(hints.join(" ")).toContain("bash");
  expect(hints.join(" ").toLowerCase()).toContain("limit");
});

test("returns one variant per non-empty, non-duplicate, non-baseline output", async () => {
  const variants = await proposeCandidates(
    deps({
      provider: scriptedMutator(["Be careful.", "Be thorough.", "", "Be careful."]),
      count: 4,
    }),
  );
  expect(variants.map((v) => v.instructions)).toEqual(["Be careful.", "Be thorough."]);
  expect(variants.map((v) => v.name)).toEqual(["mut-1", "mut-2"]);
});

test("drops an output identical to the baseline instructions", async () => {
  const variants = await proposeCandidates(
    deps({
      baseInstructions: "Be quick.",
      provider: scriptedMutator(["Be quick.", "Be better."]),
      count: 2,
    }),
  );
  expect(variants.map((v) => v.instructions)).toEqual(["Be better."]);
});

test("respects count and returns [] when aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  const variants = await proposeCandidates(
    deps({ provider: scriptedMutator(["x"]), signal: ac.signal }),
  );
  expect(variants).toEqual([]);
});

test("a mid-stream abort does not leak a partial variant", async () => {
  const ac = new AbortController();
  const provider: Provider = {
    listModels: async () => [],
    embed: async () => [],
    async *chat(): AsyncIterable<StreamEvent> {
      yield { type: "text-delta", text: "partial" };
      ac.abort();
      yield { type: "text-delta", text: " more" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const variants = await proposeCandidates(deps({ provider, signal: ac.signal, count: 2 }));
  expect(variants).toEqual([]);
});
