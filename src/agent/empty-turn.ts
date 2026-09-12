/** Why a model turn ended without a usable answer/tool call (after the retry). Note that
 *  `truncated_length` is the one kind that can fire even when partial text was produced —
 *  it marks a response cut off by the output/context limit, not an empty turn. */
export type EmptyTurnKind =
  | "empty_reasoning_markup"
  | "empty_reasoning_only"
  | "empty_nothing"
  | "truncated_length"
  | "finish_pass_error";

export interface EmptyTurnNotice {
  kind: EmptyTurnKind;
  /** Human-facing warn notice shown in the transcript. */
  text: string;
}

/** Tool-call markup tokens across Hermes/Qwen XML and OpenAI harmony. Closing-only tags are
 *  included on purpose: a model can leak `</tool_call>` into reasoning with no opening tag
 *  (observed with qwen3.6 on Ollama). Single source of truth for the detector. */
const TOOL_CALL_MARKUP = [
  "<tool_call>",
  "</tool_call>",
  "<function=",
  "</function>",
  "<parameter=",
  "</parameter>",
  "<|channel|>commentary",
  "to=functions.", // harmony recipient line; catches partial harmony where <|channel|> was stripped
  "<|call|>",
];

/** True when the reasoning text contains any tool-call markup token (case-insensitive). */
export function reasoningHasToolCallMarkup(reasoning: string): boolean {
  const r = reasoning.toLowerCase();
  return TOOL_CALL_MARKUP.some((m) => r.includes(m.toLowerCase()));
}

const TEXT: Record<Exclude<EmptyTurnKind, "finish_pass_error">, string> = {
  empty_reasoning_markup:
    "The model emitted a tool call inside its reasoning/thinking channel, so it could not be " +
    "executed. This usually means its tool-call format isn't being parsed — try a different " +
    "model, or check the provider's tool-call/template (e.g. harmony) settings.",
  empty_reasoning_only:
    "The model produced only reasoning and no final answer. Try rephrasing, or ask it to give " +
    "a final response.",
  empty_nothing:
    "The model returned an empty response (no answer or tool call). Try rephrasing or retry.",
  truncated_length:
    "The model's response was cut off — it reached the output/context-window limit before " +
    "finishing (a reasoning-heavy model can fill the window). Reply 'continue' to have it " +
    "resume. If it keeps happening, the conversation has outgrown the model's context window — " +
    "start a new session or use a model with a larger context window.",
};

/** Classify an empty model turn (no answer, no tool call) from its reasoning channel. Pure. */
export function classifyEmptyTurn(input: { reasoning: string }): EmptyTurnNotice {
  let kind: EmptyTurnKind;
  if (input.reasoning.trim().length === 0) kind = "empty_nothing";
  else if (reasoningHasToolCallMarkup(input.reasoning)) kind = "empty_reasoning_markup";
  else kind = "empty_reasoning_only";
  return { kind, text: TEXT[kind] };
}

/** The notice for a turn truncated by the output/context limit (finish_reason: length). */
export function truncationNotice(): EmptyTurnNotice {
  return { kind: "truncated_length", text: TEXT.truncated_length };
}

/** Reduce a raw provider error message to a short, chat-friendly reason. Falls back to the detail
 *  with the provider wrapper prefixes stripped. Pure. */
export function cleanFinishPassError(message: string): string {
  // First, strip the provider wrapper prefixes
  const cleaned = message
    .replace(/^PROVIDER_UNREACHABLE:\s*/i, "")
    .replace(/^chat failed:\s*/i, "")
    .trim();

  const m = cleaned.toLowerCase();
  if (m.includes("timed out") || m.includes("timeout")) return "timed out";
  if (
    m.includes("unreachable") ||
    m.includes("econnrefused") ||
    m.includes("fetch failed") ||
    m.includes("connection")
  )
    return "unreachable";
  return cleaned;
}

/** Notice for a finish/synthesis pass that failed with a provider error (timeout, unreachable),
 *  used only when the turn produced no fallback answer. Names the synthesis model and a cleaned
 *  reason so the user can act (retry / faster large tier) instead of chasing a rephrase. Pure. */
export function finishPassErrorNotice(model: string, message: string): EmptyTurnNotice {
  return {
    kind: "finish_pass_error",
    text: `The synthesis model (${model}) failed before producing the final answer (${cleanFinishPassError(message)}). The gather model's steps are above — retry, or use a faster large tier.`,
  };
}

/** Decide which turn-end notice (if any) to surface. Length-truncation takes precedence over
 *  the empty-turn classification and fires even when partial text exists (the response is
 *  incomplete regardless). Returns null when the turn ended normally. Pure. */
export function selectTurnEndNotice(input: {
  finishReason: "stop" | "tool-calls" | "length" | "error";
  finalText: string;
  reasoning: string;
  aborted: boolean;
}): EmptyTurnNotice | null {
  if (input.aborted) return null;
  if (input.finishReason === "length") return truncationNotice();
  if (input.finishReason !== "error" && input.finalText.trim().length === 0) {
    return classifyEmptyTurn({ reasoning: input.reasoning });
  }
  return null;
}
