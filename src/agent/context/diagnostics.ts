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
    `History before compaction: ${n(s.tailTokens)}; compact above ${n(s.highWaterTokens)}; target ${n(s.lowWaterTokens)}`,
    `Reserves: response ${n(s.responseReserveTokens)}, system ${n(s.systemPromptTokens)}, tools ${n(s.toolSchemaTokens)}, digest ${n(s.digestTokens)}, live request ${n(s.liveUserMessageTokens)}`,
    `Assembled input including tools: ${n(s.assembledInputTokens)}; tool-result caps: live ${n(s.liveToolResultChars)} chars, older ${n(s.deepToolResultChars)} chars`,
    "Use context.max_budget_tokens or model_profiles.<provider>.<model>.max_budget_tokens to adjust the ceiling; the served window still applies.",
  ].join("\n");
}
