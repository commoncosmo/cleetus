import { describe, expect, it, test } from "bun:test";
import { DEFAULT_CONTEXT, resolveContext } from "../../src/config/context";
import { ContextObjectSchema } from "../../src/config/schema";

test("rejects trim_low_water >= trim_high_water", () => {
  expect(() => ContextObjectSchema.parse({ trim_high_water: 0.5, trim_low_water: 0.6 })).toThrow(
    /trim_low_water must be less than trim_high_water/,
  );
  // equal also rejects
  expect(() => ContextObjectSchema.parse({ trim_high_water: 0.5, trim_low_water: 0.5 })).toThrow();
  // valid passes
  expect(() =>
    ContextObjectSchema.parse({ trim_high_water: 0.85, trim_low_water: 0.55 }),
  ).not.toThrow();
});

test("defaults include watermark + slim + warn keys", () => {
  expect(DEFAULT_CONTEXT.trimHighWater).toBe(0.85);
  expect(DEFAULT_CONTEXT.trimLowWater).toBe(0.55);
  expect(DEFAULT_CONTEXT.maxSummaryInputTokens).toBe(6000);
  expect(DEFAULT_CONTEXT.maxDeepToolResultChars).toBe(2000);
  expect(DEFAULT_CONTEXT.warnTokens).toBeNull();
});

test("project overrides global for new keys", () => {
  const c = resolveContext(
    { trim_high_water: 0.9, max_deep_tool_result_chars: 1000 },
    { trim_low_water: 0.4, warn_tokens: 40000 },
  );
  expect(c.trimHighWater).toBe(0.9); // from global (project undefined)
  expect(c.trimLowWater).toBe(0.4); // from project
  expect(c.maxDeepToolResultChars).toBe(1000); // from global
  expect(c.warnTokens).toBe(40000); // from project
});

test("default summaryTimeoutMs is 30s", () => {
  expect(DEFAULT_CONTEXT.summaryTimeoutMs).toBe(30000);
});

test("resolveContext maps summary_timeout_ms with project > global > default", () => {
  expect(resolveContext(undefined, undefined).summaryTimeoutMs).toBe(30000);
  expect(resolveContext({ summary_timeout_ms: 60000 }, undefined).summaryTimeoutMs).toBe(60000);
  expect(
    resolveContext({ summary_timeout_ms: 60000 }, { summary_timeout_ms: 45000 }).summaryTimeoutMs,
  ).toBe(45000);
});

describe("resolveContext", () => {
  it("defaults when nothing is set", () => {
    expect(resolveContext(undefined, undefined)).toEqual(DEFAULT_CONTEXT);
  });

  it("project overrides global overrides default", () => {
    const r = resolveContext({ budget_tokens: 30000, summarize: false }, { budget_tokens: 16000 });
    expect(r.budgetTokens).toBe(16000); // project wins
    expect(r.summarize).toBe(false); // global wins over default (project unset)
    expect(r.responseReserveTokens).toBe(DEFAULT_CONTEXT.responseReserveTokens);
  });

  it("project responseReserveTokens overrides global and default", () => {
    const r = resolveContext({ response_reserve_tokens: 1000 }, { response_reserve_tokens: 512 });
    expect(r.responseReserveTokens).toBe(512);
  });

  it("project wins field-by-field over global", () => {
    const r = resolveContext(
      { budget_tokens: 30000, summarize: false },
      { budget_tokens: 16000, summarize: true },
    );
    expect(r.budgetTokens).toBe(16000);
    expect(r.summarize).toBe(true);
  });
});

test("resolveContext resolves max_live_tool_result_chars project > global > default", () => {
  expect(resolveContext(undefined, undefined).maxLiveToolResultChars).toBe(12000);
  expect(resolveContext({ max_live_tool_result_chars: 5 }, undefined).maxLiveToolResultChars).toBe(
    5,
  );
  expect(
    resolveContext({ max_live_tool_result_chars: 5 }, { max_live_tool_result_chars: 9 })
      .maxLiveToolResultChars,
  ).toBe(9);
});

describe("resolveContext maxBudgetTokens", () => {
  it("defaults maxBudgetTokens to 32000", () => {
    expect(DEFAULT_CONTEXT.maxBudgetTokens).toBe(32000);
    expect(resolveContext().maxBudgetTokens).toBe(32000);
  });

  it("resolves max_budget_tokens with project over global over default", () => {
    expect(
      resolveContext({ max_budget_tokens: 200000 }, { max_budget_tokens: 64000 }).maxBudgetTokens,
    ).toBe(64000);
    expect(resolveContext({ max_budget_tokens: 64000 }, undefined).maxBudgetTokens).toBe(64000);
  });
});
