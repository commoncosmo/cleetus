import type { ParseResult, RawCall } from "../types";
import { MAX_PARSE_INPUT, TOOL_CALL_BLOCK } from "./common";

const ARG_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;

/**
 * Parse GLM-4.x tool calls: `<tool_call>name <arg_key>k</arg_key> <arg_value>v</arg_value> … </tool_call>`.
 * The function name is the leading token; args are captured as strings (the recover layer coerces
 * them to schema types). Guarded so it never claims another format's block: a block is claimed only
 * when it contains an <arg_key> pair, or its inner is a bare identifier (no `{` and no `<`). A
 * hermes-json (`{…}`) or qwen (`<function=…>`) block fails both and is left for its own parser.
 * Bails to null over MAX_PARSE_INPUT chars.
 */
export function parseGlm(text: string): ParseResult | null {
  if (text.length > MAX_PARSE_INPUT) return null;
  const calls: RawCall[] = [];
  let stripped = text;
  for (const block of text.matchAll(new RegExp(TOOL_CALL_BLOCK, "g"))) {
    const inner = block[1];
    if (inner === undefined) continue;
    const argStart = inner.indexOf("<arg_key>");
    const hasArgs = argStart >= 0;
    // No <arg_key>: only a bare identifier (no JSON, no other XML tag) is a GLM no-arg call.
    if (!hasArgs && /[{<]/.test(inner)) continue;
    const namePart = (hasArgs ? inner.slice(0, argStart) : inner).trim();
    const name = namePart.split(/\s+/)[0] ?? "";
    if (!name) continue;
    const rawArgs: Record<string, unknown> = {};
    for (const p of inner.matchAll(ARG_RE)) {
      const key = p[1]?.trim();
      const val = p[2];
      if (key === undefined || val === undefined) continue;
      rawArgs[key] = val.trim();
    }
    // Had <arg_key> markers but none parsed cleanly → malformed; leave for another parser.
    if (hasArgs && Object.keys(rawArgs).length === 0) continue;
    calls.push({ name, rawArgs });
    stripped = stripped.replace(block[0], "");
  }
  return calls.length > 0 ? { calls, stripped } : null;
}
