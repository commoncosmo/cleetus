import type { ToolCall, ToolSchema } from "../types";
import { parseCohere } from "./parsers/cohere";
import { MAX_PARSE_INPUT } from "./parsers/common";
import { parseGlm } from "./parsers/glm";
import { parseGranite } from "./parsers/granite";
import { parseHarmony } from "./parsers/harmony";
import { parseHermesJson } from "./parsers/hermes-json";
import { parseQwenXml } from "./parsers/qwen-xml";
import type { FamilyAdapter, ParseResult, ToolFormat } from "./types";

const PARSERS: Record<ToolFormat, (t: string) => ParseResult | null> = {
  harmony: parseHarmony,
  "qwen-xml": parseQwenXml,
  "hermes-json": parseHermesJson,
  granite: parseGranite,
  glm: parseGlm,
  cohere: parseCohere,
};
const ALL_FORMATS: ToolFormat[] = [
  "harmony",
  "qwen-xml",
  "hermes-json",
  "granite",
  "glm",
  "cohere",
];

export interface RecoverInput {
  content: string;
  reasoning: string;
  tools?: ToolSchema[];
  family?: FamilyAdapter | null;
  /** Per-model-call salt so IDs are unique across calls (duplicate `recovered-0-*` collisions
   *  otherwise corrupt multi-turn history). Optional: omitted → legacy `recovered-${i}-${name}`. */
  idSeed?: string;
}

/** Try each format (preferred first), returning the first that yields ≥1 call. Fail-safe. */
function parseAny(text: string, family?: FamilyAdapter | null): ParseResult | null {
  if (!text.trim()) return null;
  const order: ToolFormat[] = family
    ? [family.preferredFormat, ...ALL_FORMATS.filter((f) => f !== family.preferredFormat)]
    : ALL_FORMATS;
  for (const fmt of order) {
    try {
      const r = PARSERS[fmt](text);
      if (r && r.calls.length > 0) return r;
    } catch {
      /* fail-safe: try the next format */
    }
  }
  return null;
}

function propType(schema: ToolSchema | undefined, key: string): string | undefined {
  const props = (schema?.parameters as { properties?: Record<string, { type?: string }> })
    ?.properties;
  return props?.[key]?.type;
}

function coerceValue(v: unknown, type: string | undefined): unknown {
  if (typeof v !== "string") return v; // JSON formats are already typed
  if (type === "number" || type === "integer") {
    // Keep blank/whitespace as-is: Number("") is 0, which would mask an obviously-broken
    // arg as a plausible 0. Let it stay a string and fail normal validation visibly.
    if (v.trim() === "") return v;
    const n = Number(v);
    return Number.isNaN(n) ? v : n;
  }
  if (type === "boolean") {
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
    return v;
  }
  if (type === "object" || type === "array") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** Recover tool calls a server failed to parse, from `content` (then `reasoning`).
 *  Strict: only emits calls whose name matches a registered tool. Pure, fail-safe. */
export function recoverToolCalls(input: RecoverInput): { calls: ToolCall[] } {
  const parsed = parseAny(input.content, input.family) ?? parseAny(input.reasoning, input.family);
  if (!parsed) return { calls: [] };
  const schemas = new Map((input.tools ?? []).map((t) => [t.name, t]));
  const calls: ToolCall[] = [];
  let i = 0;
  for (const raw of parsed.calls) {
    const schema = schemas.get(raw.name);
    if (!schema) continue; // strict: unknown tool → drop
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw.rawArgs)) {
      args[k] = coerceValue(v, propType(schema, k));
    }
    const id = input.idSeed
      ? `recovered-${input.idSeed}-${i++}-${raw.name}`
      : `recovered-${i++}-${raw.name}`;
    calls.push({ id, name: raw.name, args });
  }
  return { calls };
}

/** Remove known tool-call markup blocks so leaked text never pollutes stored history.
 *  The harmony branch matches end-of-string too, mirroring parseHarmony's terminator, so an
 *  unterminated commentary block is stripped (not left behind). Bounded by MAX_PARSE_INPUT. */
export function stripToolCallMarkup(text: string): string {
  if (text.length > MAX_PARSE_INPUT) return text;
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<\|channel\|>commentary[\s\S]*?(?:<\|call\|>|<\|end\|>|$)/gi, "")
    .replace(/<\|tool_call\|>\s*\[[\s\S]*?\]/gi, "")
    .replace(/<\|START_ACTION\|>[\s\S]*?<\|END_ACTION\|>/gi, "")
    .trim();
}
