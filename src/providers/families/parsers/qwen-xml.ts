import type { ParseResult, RawCall } from "../types";
import { MAX_PARSE_INPUT, TOOL_CALL_BLOCK } from "./common";

const FUNC_RE = /<function=([\w.-]+)>([\s\S]*?)<\/function>/;
const PARAM_RE = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g;

/** Parse Qwen3-Coder XML tool calls. Returns null unless a <tool_call> wraps a <function=…>.
 *  Blocks whose inner is valid JSON are Hermes calls, not qwen — skipped. */
export function parseQwenXml(text: string): ParseResult | null {
  if (text.length > MAX_PARSE_INPUT) return null;
  const calls: RawCall[] = [];
  let stripped = text;
  for (const block of text.matchAll(new RegExp(TOOL_CALL_BLOCK, "g"))) {
    const inner = block[1];
    if (inner === undefined) continue;
    try {
      JSON.parse(inner.trim());
      continue; // valid JSON → a hermes-json block, not qwen-xml
    } catch {
      /* not JSON → proceed to XML parsing */
    }
    const fn = FUNC_RE.exec(inner);
    if (!fn) continue;
    const name = fn[1];
    const paramsBody = fn[2];
    if (!name || paramsBody === undefined) continue;
    const rawArgs: Record<string, unknown> = {};
    for (const p of paramsBody.matchAll(PARAM_RE)) {
      const key = p[1];
      const val = p[2];
      if (key === undefined || val === undefined) continue;
      rawArgs[key] = val;
    }
    calls.push({ name, rawArgs });
    stripped = stripped.replace(block[0], "");
  }
  return calls.length > 0 ? { calls, stripped } : null;
}
