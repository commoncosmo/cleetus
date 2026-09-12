import type { ParseResult, RawCall } from "../types";
import { MAX_PARSE_INPUT, TOOL_CALL_BLOCK } from "./common";

/** Parse Hermes-style `<tool_call>{json}</tool_call>` calls. Returns null unless the body is
 *  JSON with a string `name` (so a qwen-xml `<function=…>` block is skipped). */
export function parseHermesJson(text: string): ParseResult | null {
  if (text.length > MAX_PARSE_INPUT) return null;
  const calls: RawCall[] = [];
  let stripped = text;
  for (const block of text.matchAll(new RegExp(TOOL_CALL_BLOCK, "g"))) {
    const inner = block[1];
    if (inner === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(inner.trim());
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as { name?: unknown; arguments?: unknown };
    if (typeof obj.name !== "string") continue;
    const rawArgs =
      obj.arguments && typeof obj.arguments === "object"
        ? (obj.arguments as Record<string, unknown>)
        : {};
    calls.push({ name: obj.name, rawArgs });
    stripped = stripped.replace(block[0], "");
  }
  return calls.length > 0 ? { calls, stripped } : null;
}
