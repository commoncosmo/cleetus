import { describe, expect, it } from "bun:test";
import {
  budgetBase,
  budgetUpgradeNotice,
  computeBudget,
  estimateTokens,
  safeAssembledInputLimit,
} from "../../../src/agent/context/budget";

describe("estimateTokens", () => {
  it("is ~len/4 and monotonic", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("a".repeat(401))).toBeGreaterThan(estimateTokens("a".repeat(400)));
  });
});

describe("safeAssembledInputLimit", () => {
  it("leaves conservative tokenizer and response headroom for known windows", () => {
    expect(safeAssembledInputLimit(4096)).toBe(3358);
    expect(safeAssembledInputLimit(0)).toBeUndefined();
    expect(safeAssembledInputLimit(undefined)).toBeUndefined();
  });
});

describe("budgetBase", () => {
  it("returns the configured fallback when the window is unknown", () => {
    expect(budgetBase({ configBudgetTokens: 24000, maxBudgetTokens: 96000 })).toBe(16384);
  });

  it("returns the served window when known and under the ceiling", () => {
    expect(
      budgetBase({ contextLength: 32000, configBudgetTokens: 24000, maxBudgetTokens: 96000 }),
    ).toBe(32000);
  });

  it("caps a large served window at maxBudgetTokens", () => {
    expect(
      budgetBase({ contextLength: 256000, configBudgetTokens: 24000, maxBudgetTokens: 96000 }),
    ).toBe(96000);
  });

  it("treats a zero window sentinel as unknown and uses the safe fallback", () => {
    expect(
      budgetBase({ contextLength: 0, configBudgetTokens: 24000, maxBudgetTokens: 96000 }),
    ).toBe(16384);
  });

  it("treats negative and non-finite window metadata as unknown", () => {
    for (const contextLength of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(budgetBase({ contextLength, configBudgetTokens: 24000, maxBudgetTokens: 96000 })).toBe(
        16384,
      );
    }
  });

  it("budgetBase: unknown window clamps the fallback to 16384", () => {
    expect(
      budgetBase({ contextLength: undefined, configBudgetTokens: 24000, maxBudgetTokens: 96000 }),
    ).toBe(16384);
  });

  it("budgetBase: unknown window keeps a configured fallback smaller than the clamp", () => {
    expect(
      budgetBase({ contextLength: undefined, configBudgetTokens: 8000, maxBudgetTokens: 96000 }),
    ).toBe(8000);
  });

  it("budgetBase: known window is unaffected by the clamp", () => {
    expect(
      budgetBase({ contextLength: 131072, configBudgetTokens: 24000, maxBudgetTokens: 96000 }),
    ).toBe(96000);
  });
});

describe("computeBudget", () => {
  const base = {
    responseReserveTokens: 2000,
    systemPromptTokens: 1000,
    digestTokens: 0,
    maxBudgetTokens: 96000,
  };

  it("uses configBudget with margin minus reserves", () => {
    // configBudgetTokens 20000 clamped to 16384 → floor(16384*0.9) - 2000 - 1000 = 14745 - 3000 = 11745
    expect(computeBudget({ ...base, configBudgetTokens: 20000, toolSchemaTokens: 0 })).toBe(11745);
  });

  it("prefers the smaller of contextLength and the ceiling", () => {
    const withCtx = computeBudget({
      ...base,
      configBudgetTokens: 20000,
      contextLength: 8000,
      toolSchemaTokens: 0,
    });
    // floor(8000*0.9) - 3000 = 7200 - 3000 = 4200
    expect(withCtx).toBe(4200);
  });

  it("scales a large known window up to the ceiling, far above the old 24K cap", () => {
    // contextLength 256000 capped at 96000 → floor(96000*0.9) - 3000 = 86400 - 3000 = 83400
    const big = computeBudget({
      ...base,
      configBudgetTokens: 24000,
      contextLength: 256000,
      toolSchemaTokens: 0,
    });
    expect(big).toBe(83400);
    expect(big).toBeGreaterThan(
      computeBudget({ ...base, configBudgetTokens: 24000, toolSchemaTokens: 0 }),
    );
  });

  it("subtracts the current digest size", () => {
    expect(
      computeBudget({ ...base, configBudgetTokens: 20000, digestTokens: 500, toolSchemaTokens: 0 }),
    ).toBe(11245);
  });

  it("never returns below the floor", () => {
    expect(computeBudget({ ...base, configBudgetTokens: 100, toolSchemaTokens: 0 })).toBe(512);
  });

  it("subtracts the live user-message reserve when provided", () => {
    const baseBudget = computeBudget({
      configBudgetTokens: 24000,
      maxBudgetTokens: 96000,
      responseReserveTokens: 2048,
      systemPromptTokens: 1000,
      digestTokens: 0,
      toolSchemaTokens: 0,
    });
    const withReserve = computeBudget({
      configBudgetTokens: 24000,
      maxBudgetTokens: 96000,
      responseReserveTokens: 2048,
      systemPromptTokens: 1000,
      digestTokens: 0,
      liveUserMessageTokens: 500,
      toolSchemaTokens: 0,
    });
    expect(baseBudget - withReserve).toBe(500);
  });

  it("treats an absent live user-message reserve as zero", () => {
    const a = computeBudget({
      configBudgetTokens: 24000,
      maxBudgetTokens: 96000,
      responseReserveTokens: 2048,
      systemPromptTokens: 1000,
      digestTokens: 0,
      toolSchemaTokens: 0,
    });
    const b = computeBudget({
      configBudgetTokens: 24000,
      maxBudgetTokens: 96000,
      responseReserveTokens: 2048,
      systemPromptTokens: 1000,
      digestTokens: 0,
      liveUserMessageTokens: 0,
      toolSchemaTokens: 0,
    });
    expect(a).toBe(b);
  });

  it("subtracts tool-schema tokens from the budget", () => {
    const base = {
      contextLength: 32768,
      configBudgetTokens: 24000,
      maxBudgetTokens: 96000,
      responseReserveTokens: 2048,
      systemPromptTokens: 1000,
      digestTokens: 0,
    };
    const without = computeBudget({ ...base, toolSchemaTokens: 0 });
    const withTools = computeBudget({ ...base, toolSchemaTokens: 3000 });
    expect(withTools).toBe(without - 3000);
  });

  it("8K window with realistic overheads floors at MIN_BUDGET", () => {
    // floor(8192*0.9)=7372, minus reserve 2048, system 3000, schemas 3000 → negative → 512
    const budget = computeBudget({
      contextLength: 8192,
      configBudgetTokens: 24000,
      maxBudgetTokens: 96000,
      responseReserveTokens: 2048,
      systemPromptTokens: 3000,
      digestTokens: 0,
      toolSchemaTokens: 3000,
    });
    expect(budget).toBe(512);
  });
});

const OPTS = { configBudgetTokens: 24000, maxBudgetTokens: 96000 };

describe("budgetUpgradeNotice", () => {
  it("formats a notice on the undefined → known transition", () => {
    const note = budgetUpgradeNotice("qwen3.5:122b-a10b", undefined, 262144, OPTS);
    expect(note).toBe(
      "context window detected: qwen3.5:122b-a10b = 262144 tokens — history budget 16K → 96K",
    );
  });

  it("returns null when the window was already known (no upgrade)", () => {
    expect(budgetUpgradeNotice("m", 131072, 262144, OPTS)).toBeNull();
  });

  it("returns null when the new window is still unknown", () => {
    expect(budgetUpgradeNotice("m", undefined, undefined, OPTS)).toBeNull();
  });

  it("ignores a zero window sentinel", () => {
    expect(budgetUpgradeNotice("m", undefined, 0, OPTS)).toBeNull();
  });

  it("caps the new budget at maxBudgetTokens for a window larger than the cap", () => {
    // 262144 window → min(262144, 96000) = 96000 → 96K
    expect(budgetUpgradeNotice("m", undefined, 262144, OPTS)).toContain("16K → 96K");
  });
});
