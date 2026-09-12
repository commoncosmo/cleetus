import type { ParseResult, RawCall } from "../types";
import { MAX_PARSE_INPUT } from "./common";

// <|tool_call|> followed by a JSON array of {name, arguments}.
const GRANITE_RE = /<\|tool_call\|>\s*(\[[\s\S]*?\])/g;

/** Parse IBM Granite `<|tool_call|>[{...}]` calls. Returns null when none parse. */
export function parseGranite(text: string): ParseResult | null {
  if (text.length > MAX_PARSE_INPUT) return null;
  const calls: RawCall[] = [];
  let stripped = text;
  for (const m of text.matchAll(GRANITE_RE)) {
    const jsonArr = m[1];
    if (jsonArr === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonArr);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    let any = false;
    for (const el of parsed) {
      if (!el || typeof el !== "object") continue;
      const obj = el as { name?: unknown; arguments?: unknown };
      if (typeof obj.name !== "string") continue;
      const rawArgs =
        obj.arguments && typeof obj.arguments === "object"
          ? (obj.arguments as Record<string, unknown>)
          : {};
      calls.push({ name: obj.name, rawArgs });
      any = true;
    }
    if (any) stripped = stripped.replace(m[0], "");
  }
  return calls.length > 0 ? { calls, stripped } : null;
}
