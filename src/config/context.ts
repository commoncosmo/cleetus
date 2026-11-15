import type { RawContext } from "./schema";

/** Resolved context-window management settings. */
export interface ContextConfig {
  /** Fallback budget for history+digest when the model's served context window is unknown. */
  budgetTokens: number;
  /** Ceiling on the history+digest budget when the served window IS known (caps per-call
   *  latency/VRAM on big-window models). */
  maxBudgetTokens: number;
  /** Tokens held back from the budget for the model's response. */
  responseReserveTokens: number;
  /** Keep a digest of evicted history. Automatic folds are local; /compact uses the model. */
  summarize: boolean;
  /** Fraction of budget that triggers a trim. */
  trimHighWater: number;
  /** Fraction of budget a trim reduces the tail to. */
  trimLowWater: number;
  /** Slice size (tokens) above which /compact summarizes in sub-chunks. */
  maxSummaryInputTokens: number;
  /** Total time (ms) /compact allows for model summarization before relying on local evidence. */
  summaryTimeoutMs: number;
  /** Per-message cap (chars) for tool results in deep (pre-live) history. */
  maxDeepToolResultChars: number;
  /** Per-message cap (chars) for tool results in the LIVE turn — larger than the deep cap so a
   *  single fresh result can't dominate the sent per-call input. */
  maxLiveToolResultChars: number;
  /** Assembled-input token count that fires the one-shot warning. Null = derive
   *  from the model's context length (70%) or fall back to 50000. */
  warnTokens: number | null;
}

export const DEFAULT_CONTEXT: ContextConfig = {
  budgetTokens: 24000,
  maxBudgetTokens: 32000,
  responseReserveTokens: 2048,
  summarize: true,
  trimHighWater: 0.85,
  trimLowWater: 0.55,
  maxSummaryInputTokens: 6000,
  summaryTimeoutMs: 30000,
  maxDeepToolResultChars: 2000,
  maxLiveToolResultChars: 12000,
  warnTokens: null,
};

/** Resolve context settings with project > global > default precedence. Pure. */
export function resolveContext(global?: RawContext, project?: RawContext): ContextConfig {
  return {
    budgetTokens: project?.budget_tokens ?? global?.budget_tokens ?? DEFAULT_CONTEXT.budgetTokens,
    maxBudgetTokens:
      project?.max_budget_tokens ?? global?.max_budget_tokens ?? DEFAULT_CONTEXT.maxBudgetTokens,
    responseReserveTokens:
      project?.response_reserve_tokens ??
      global?.response_reserve_tokens ??
      DEFAULT_CONTEXT.responseReserveTokens,
    summarize: project?.summarize ?? global?.summarize ?? DEFAULT_CONTEXT.summarize,
    trimHighWater:
      project?.trim_high_water ?? global?.trim_high_water ?? DEFAULT_CONTEXT.trimHighWater,
    trimLowWater: project?.trim_low_water ?? global?.trim_low_water ?? DEFAULT_CONTEXT.trimLowWater,
    maxSummaryInputTokens:
      project?.max_summary_input_tokens ??
      global?.max_summary_input_tokens ??
      DEFAULT_CONTEXT.maxSummaryInputTokens,
    summaryTimeoutMs:
      project?.summary_timeout_ms ?? global?.summary_timeout_ms ?? DEFAULT_CONTEXT.summaryTimeoutMs,
    maxDeepToolResultChars:
      project?.max_deep_tool_result_chars ??
      global?.max_deep_tool_result_chars ??
      DEFAULT_CONTEXT.maxDeepToolResultChars,
    maxLiveToolResultChars:
      project?.max_live_tool_result_chars ??
      global?.max_live_tool_result_chars ??
      DEFAULT_CONTEXT.maxLiveToolResultChars,
    warnTokens: project?.warn_tokens ?? global?.warn_tokens ?? DEFAULT_CONTEXT.warnTokens,
  };
}
