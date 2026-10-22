import { expect, test } from "bun:test";
import {
  type ContextBudgetSnapshot,
  formatContextBudget,
} from "../../../src/agent/context/diagnostics";

const snapshot: ContextBudgetSnapshot = {
  provider: "vllm",
  model: "test-model",
  contextLength: 131072,
  baseTokens: 32000,
  maxBudgetTokens: 32000,
  budgetTokens: 18242,
  tailTokens: 12100,
  highWaterTokens: 15505.7,
  lowWaterTokens: 10033.1,
  responseReserveTokens: 2048,
  systemPromptTokens: 3500,
  digestTokens: 0,
  toolSchemaTokens: 5000,
  liveUserMessageTokens: 10,
  assembledInputTokens: 20600,
  liveToolResultChars: 12000,
  deepToolResultChars: 2000,
};

test("context report distinguishes served capacity, configured ceiling, and actual pressure", () => {
  const report = formatContextBudget(snapshot);
  expect(report).toContain("vllm/test-model");
  expect(report).toContain("Served window: 131,072; budget base: 32,000");
  expect(report).toContain("History budget: 18,242");
  expect(report).toContain("compact above 15,505");
  expect(report).toContain("tools 5,000");
  expect(report).toContain("Assembled input including tools: 20,600");
});

test("context report marks unknown capacity and an unsampled session explicitly", () => {
  expect(
    formatContextBudget({ ...snapshot, contextLength: undefined, baseTokens: 16384 }),
  ).toContain("unknown (fallback clamped to 16,384)");
  expect(formatContextBudget()).toContain("No context budget sampled yet");
});

test("context report explains an apparently tiny share of a large reported window", () => {
  const report = formatContextBudget({
    ...snapshot,
    contextLength: 1048576,
    budgetTokens: 11343,
    evidenceTokens: 200,
  });
  expect(report).toContain("ceiling uses 3.1%");
  expect(report).toContain("usable history is 1.1%");
  expect(report).toContain("evidence 200");
  expect(report).toContain("Raising budget_tokens alone does not increase");
});
