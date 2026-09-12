import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SmartConfig } from "../../src/config/types";
import type { RunnerDeps } from "../../src/eval/runner";
import type { Scenario } from "../../src/eval/scenario";
import { composePrompt } from "../../src/improve/promote";
import { type ImproveRoundDeps, runImproveRound } from "../../src/improve/round";
import { analyzeReasoningCost } from "../../src/insights/analyzers/reasoning-cost";
import type { InsightsReport } from "../../src/insights/report";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, StreamEvent } from "../../src/providers/types";
import type { ExecOptions, ExecResult, Sandbox } from "../../src/sandbox/types";

const SMART: SmartConfig = {
  escalateAfterFailures: 3,
  deescalateAfterSuccesses: 2,
  broadCodePlanCalls: 5,
  contextWindowPercent: 70,
  escalateOnCodeEdit: "always",
  keywords: [],
};

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

// Mutation model: returns one revised block containing the WINNER marker.
function mutationProvider(): Provider {
  return {
    listModels: async () => [],
    embed: async () => [],
    async *chat(): AsyncIterable<StreamEvent> {
      yield { type: "text-delta", text: "Always create the file. WINNER" };
      yield { type: "finish", reason: "stop" };
    },
  };
}

// Eval agent: writes the file (→ check passes) only when its system prompt contains WINNER.
// Keyed on message history (a prior tool result), NOT a call counter, so the single
// registered instance behaves correctly across every run.
function evalAgentProvider(): Provider {
  return {
    listModels: async () => [],
    embed: async () => [],
    async *chat(opts): AsyncIterable<StreamEvent> {
      const sys = opts.messages.find((m) => m.role === "system")?.content ?? "";
      const alreadyRanTool = opts.messages.some((m) => m.role === "tool");
      if (sys.includes("WINNER") && !alreadyRanTool) {
        yield {
          type: "tool-call",
          call: { id: "c1", name: "bash", args: { command: "echo -n ok > out.txt" } },
        };
        yield { type: "finish", reason: "tool-calls" };
      } else {
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

// Stateful per-run: the check passes only if the agent's write actually ran in this
// container. A fresh instance is created per run via `makeSandbox: () => fakeSandbox()`.
function fakeSandbox(): Sandbox {
  let wrote = false;
  return {
    async exec(command: string, _opts: ExecOptions): Promise<ExecResult> {
      if (command.includes("echo")) wrote = true;
      const exitCode = command === "CHECK" ? (wrote ? 0 : 1) : 0;
      return { stdout: "", stderr: "", exitCode, timedOut: false, cancelled: false };
    },
    async dispose() {},
    writeRoot: () => null,
  };
}

function scenario(): Scenario {
  return {
    name: "s",
    prompt: "do it",
    check: "CHECK",
    checkTimeoutMs: 1000,
    agentTimeoutMs: 5000,
    fixtureDir: null,
  };
}

function deps(over: Partial<ImproveRoundDeps>): ImproveRoundDeps {
  const providers = new ProviderRegistry();
  providers.register("p", evalAgentProvider());
  const runnerDeps: RunnerDeps = {
    providers,
    sandboxConfig: { backend: "docker", image: "x", network: true },
    makeSandbox: () => fakeSandbox(),
    baseline: {
      systemPrompt: composePrompt("", "Be quick.", ""),
      active: { provider: "p", model: "m" },
      mode: "manual",
      tiers: undefined,
      smart: SMART,
      maxToolLoops: 10,
    },
  };
  return {
    provider: mutationProvider(),
    model: "m",
    runnerDeps,
    scenarios: [scenario()],
    baseInstructions: "Be quick.",
    globalContext: "",
    memoriesContext: "",
    report: emptyReport(),
    samples: [],
    count: 1,
    trials: 1,
    apply: false,
    projectDir: mkdtempSync(join(tmpdir(), "cleetus-round-")),
    now: 1,
    ...over,
  };
}

test("proposes a winning variant that beats the baseline", async () => {
  const result = await runImproveRound(deps({ apply: false }));
  expect(result.winner?.name).toBe("mut-1");
  expect(result.applied).toBe(false);
  expect(result.diff).toBeDefined();
  expect(result.comparison.ranked.find((c) => c.candidate === "mut-1")?.passed).toBe(1);
});

test("--apply writes the winning instructions block with a backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cleetus-round-apply-"));
  mkdirSync(join(dir, ".cleetus"), { recursive: true });
  writeFileSync(join(dir, ".cleetus", "instructions.md"), "Be quick.");
  const result = await runImproveRound(deps({ apply: true, projectDir: dir, now: 99 }));
  expect(result.applied).toBe(true);
  expect(readFileSync(join(dir, ".cleetus", "instructions.md"), "utf8")).toContain("WINNER");
  expect(result.backupPath).toBe(join(dir, ".cleetus", "instructions.md.bak-99"));
});

test("returns a note and no winner when mutation yields nothing usable", async () => {
  const emptyMutator: Provider = {
    listModels: async () => [],
    embed: async () => [],
    async *chat(): AsyncIterable<StreamEvent> {
      yield { type: "finish", reason: "stop" };
    },
  };
  const result = await runImproveRound(deps({ provider: emptyMutator }));
  expect(result.winner).toBeNull();
  expect(result.note?.toLowerCase()).toContain("no usable");
});
