/** Shared <tool_call>…</tool_call> envelope so qwen-xml and hermes-json can't drift on it.
 *  Untempered lazy inner span (correctness: tool-call args may legitimately contain the literal
 *  token `<tool_call>`); CPU is bounded by MAX_PARSE_INPUT instead. Build a fresh RegExp per use
 *  to avoid shared lastIndex state. */
export const TOOL_CALL_BLOCK = "<tool_call>([\\s\\S]*?)<\\/tool_call>";

/** Recovery parsers run on a single model turn's text. Above this many characters the input is
 *  pathological (no real single tool-call response is this large), so parsers bail to null —
 *  this caps the cost of the untempered lazy spans (worst-case O(n²)) at a small constant.
 *  Fail-safe: skipping recovery on absurd input falls back to normal empty-turn handling. */
export const MAX_PARSE_INPUT = 100_000;
