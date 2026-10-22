/** Measurements from the last assembly, including the pressure check before any compaction. */
export interface ContextBudgetSnapshot {
  provider: string;
  model: string;
  contextLength?: number;
  baseTokens: number;
  maxBudgetTokens: number;
  budgetTokens: number;
  tailTokens: number;
  highWaterTokens: number;
  lowWaterTokens: number;
  responseReserveTokens: number;
  systemPromptTokens: number;
  digestTokens: number;
  evidenceTokens?: number;
  toolSchemaTokens: number;
  liveUserMessageTokens: number;
  assembledInputTokens: number;
  liveToolResultChars: number;
  deepToolResultChars: number;
}

export function formatContextBudget(snapshot?: ContextBudgetSnapshot): string {
  if (!snapshot) return "No context budget sampled yet. Send a message, then run /context.";
  const s = snapshot;
  const n = (value: number) => Math.floor(value).toLocaleString("en-US");
  return [
    `Last assembled request: ${s.provider}/${s.model} (estimated tokens)`,
    `Served window: ${s.contextLength === undefined ? "unknown (fallback clamped to 16,384)" : n(s.contextLength)}; budget base: ${n(s.baseTokens)}; configured ceiling: ${n(s.maxBudgetTokens)}`,
    `History budget: ${n(s.budgetTokens)} after 10% safety margin and reserves`,
    ...(s.contextLength !== undefined && s.baseTokens < s.contextLength
      ? [
          `Configured ceiling uses ${((100 * s.baseTokens) / s.contextLength).toFixed(1)}% of the reported window; usable history is ${((100 * s.budgetTokens) / s.contextLength).toFixed(1)}%. Compaction follows the effective history budget, not the full reported window.`,
        ]
      : []),
    `History before compaction: ${n(s.tailTokens)}; compact above ${n(s.highWaterTokens)}; target ${n(s.lowWaterTokens)}`,
    `Reserves: response ${n(s.responseReserveTokens)}, system ${n(s.systemPromptTokens)}, tools ${n(s.toolSchemaTokens)}, digest ${n(s.digestTokens)}, evidence ${n(s.evidenceTokens ?? 0)}, live request ${n(s.liveUserMessageTokens)}`,
    `Assembled input including tools: ${n(s.assembledInputTokens)}; tool-result caps: live ${n(s.liveToolResultChars)} chars, older ${n(s.deepToolResultChars)} chars`,
    "Use context.max_budget_tokens or model_profiles.<provider>.<model>.max_budget_tokens to adjust the ceiling; the served window still applies.",
    `For this model, tune model_profiles.${s.provider}.${s.model}.max_budget_tokens after confirming its usable server window. Raising budget_tokens alone does not increase a known model's ceiling.`,
  ].join("\n");
}
