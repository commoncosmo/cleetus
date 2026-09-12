import type { ParseResult, RawCall } from "../types";
import { MAX_PARSE_INPUT } from "./common";

const ACTION_RE = /<\|START_ACTION\|>([\s\S]*?)<\|END_ACTION\|>/g;

/**
 * Parse Cohere North/Command tool calls:
 * `<|START_ACTION|>[{"tool_call_id":"0","tool_name":"bash","parameters":{…}}]<|END_ACTION|>`.
 * The action body is a JSON array; each object's `tool_name` is the call name and `parameters`
 * (already-typed JSON) is the args; `tool_call_id` is ignored (recover assigns its own ids).
 * The `<|START_ACTION|>` envelope is unique to Cohere, so no cross-format guard is needed. A
 * malformed (bad-JSON / non-array) body is skipped, not fatal. Bails to null over MAX_PARSE_INPUT.
 */
export function parseCohere(text: string): ParseResult | null {
  if (text.length > MAX_PARSE_INPUT) return null;
  const calls: RawCall[] = [];
  let stripped = text;
  for (const block of text.matchAll(ACTION_RE)) {
    const inner = block[1];
    if (inner === undefined) continue;
    let arr: unknown;
    try {
      arr = JSON.parse(inner.trim());
    } catch {
      continue; // malformed action body → skip
    }
    if (!Array.isArray(arr)) continue;
    let claimed = false;
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.tool_name !== "string" || !o.tool_name) continue;
      const params = o.parameters;
      const rawArgs =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      calls.push({ name: o.tool_name, rawArgs });
      claimed = true;
    }
    if (claimed) stripped = stripped.replace(block[0], "");
  }
  return calls.length > 0 ? { calls, stripped } : null;
}
