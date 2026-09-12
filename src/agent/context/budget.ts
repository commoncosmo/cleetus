/** Fraction of the raw context window we allow ourselves to fill (leaves slack for
 *  tokenizer-estimate error and provider overhead). */
const SAFETY_MARGIN = 0.9;
/** Floor so a tiny/misconfigured budget still sends the live turn rather than nothing. */
const MIN_BUDGET = 512;
/** Ceiling on the unknown-window fallback. Mirrors LOW_CONTEXT_THRESHOLD in
 *  src/providers/native-context.ts: when the served window can't be detected it may
 *  genuinely be this small — overflow is silent and catastrophic, under-use is visible
 *  and self-corrects once detection lands (budgetUpgradeNotice reports the upgrade). */
const UNKNOWN_WINDOW_CLAMP = 16384;
/** Conservative assembled-input ceiling. This is checked after all messages and tool schemas are
 * known, leaving room for tokenizer variance and a useful response on OpenAI-compatible servers
 * that enforce one combined context window. */
const ASSEMBLED_INPUT_MARGIN = 0.82;

/** Defensive normalization at the budgeting boundary. Provider adapters and the context cache
 * also reject these sentinels, but this keeps custom/legacy modelContextLength callbacks safe. */
export function normalizeContextLength(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** Rough token count: ~4 chars/token, rounded up (deliberately a slight over-estimate so
 *  we under-fill rather than overflow). No tokenizer dependency. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function safeAssembledInputLimit(contextLength: number | undefined): number | undefined {
  const normalized = normalizeContextLength(contextLength);
  return normalized === undefined
    ? undefined
    : Math.max(512, Math.floor(normalized * ASSEMBLED_INPUT_MARGIN));
}

/** Token base for budgeting: the served window when known (capped at maxBudgetTokens),
 *  else the configured fallback for an unknown window. Pure. */
export function budgetBase(opts: {
  contextLength?: number;
  configBudgetTokens: number;
  maxBudgetTokens: number;
}): number {
  const contextLength = normalizeContextLength(opts.contextLength);
  const cap =
    contextLength !== undefined
      ? opts.maxBudgetTokens
      : Math.min(opts.configBudgetTokens, opts.maxBudgetTokens, UNKNOWN_WINDOW_CLAMP);
  return Math.min(contextLength ?? Number.POSITIVE_INFINITY, cap);
}

/**
 * Token budget available for history + digest on one model call. Derives the base from
 * budgetBase — the served window when known (capped at maxBudgetTokens), else the
 * configured fallback — applies the safety margin, then subtracts the response reserve,
 * system prompt, current digest, tool schemas, and any live user-message reserve. Floored at
 * MIN_BUDGET. Pure.
 */
export function computeBudget(opts: {
  contextLength?: number;
  configBudgetTokens: number;
  maxBudgetTokens: number;
  responseReserveTokens: number;
  systemPromptTokens: number;
  digestTokens: number;
  /** Tokens consumed by the serialized tool schemas sent with every call (0 when the
   *  call carries no tools). A required term: schemas are ~2.5-3.5K tokens and omitting
   *  them silently overflows small served windows. */
  toolSchemaTokens: number;
  /** Tokens reserved for the always-kept originating user message of the live turn. */
  liveUserMessageTokens?: number;
}): number {
  const base = budgetBase({
    contextLength: opts.contextLength,
    configBudgetTokens: opts.configBudgetTokens,
    maxBudgetTokens: opts.maxBudgetTokens,
  });
  const budget =
    Math.floor(base * SAFETY_MARGIN) -
    opts.responseReserveTokens -
    opts.systemPromptTokens -
    opts.digestTokens -
    opts.toolSchemaTokens -
    (opts.liveUserMessageTokens ?? 0);
  return Math.max(budget, MIN_BUDGET);
}

/** Round a token count to a compact "NK" label for notices. */
function fmtK(tokens: number): string {
  return `${Math.round(tokens / 1000)}K`;
}

/** A one-shot notice when a model's served context window becomes known mid-session
 *  (undefined → known) — reporting the history-budget base before and after. Returns null for any
 *  other transition (so a window known from the first call never notifies, and a still-unknown
 *  window stays silent). Pure. */
export function budgetUpgradeNotice(
  model: string,
  oldContextLength: number | undefined,
  newContextLength: number | undefined,
  opts: { configBudgetTokens: number; maxBudgetTokens: number },
): string | null {
  const oldWindow = normalizeContextLength(oldContextLength);
  const newWindow = normalizeContextLength(newContextLength);
  if (oldWindow !== undefined || newWindow === undefined) return null;
  const oldBudget = budgetBase({ contextLength: undefined, ...opts });
  const newBudget = budgetBase({ contextLength: newWindow, ...opts });
  return `context window detected: ${model} = ${newWindow} tokens — history budget ${fmtK(oldBudget)} → ${fmtK(newBudget)}`;
}
