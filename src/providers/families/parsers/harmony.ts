import type { ParseResult, RawCall } from "../types";
import { MAX_PARSE_INPUT } from "./common";

// Captures: to=functions.NAME ... <|message|>JSON up to <|call|> / <|end|> / end-of-string.
const HARMONY_RE =
  /<\|channel\|>commentary\s+to=functions\.([\w.-]+)[\s\S]*?<\|message\|>([\s\S]*?)(?:<\|call\|>|<\|end\|>|$)/g;

/** Parse gpt-oss harmony commentary-channel tool calls. Returns null when none present. */
export function parseHarmony(text: string): ParseResult | null {
  if (text.length > MAX_PARSE_INPUT) return null;
  const calls: RawCall[] = [];
  let stripped = text;
  for (const match of text.matchAll(HARMONY_RE)) {
    const name = match[1];
    const body = match[2];
    if (!name || body === undefined) continue;
    let rawArgs: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body.trim());
      if (!parsed || typeof parsed !== "object") continue;
      rawArgs = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    calls.push({ name, rawArgs });
    stripped = stripped.replace(match[0], "");
  }
  return calls.length > 0 ? { calls, stripped } : null;
}
