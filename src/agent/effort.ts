import { detectFamily } from "../providers/families";
import type { ChatOptions, Message } from "../providers/types";

/** Reasoning-effort levels the dial offers. Always on; `medium` is the neutral middle. `xhigh` is
 *  an extended tier only some families honor (e.g. Muse); elsewhere it clamps to `high`. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh";

export interface EffortOption {
  id: EffortLevel;
  description: string;
}

export const EFFORTS: EffortOption[] = [
  { id: "low", description: "fast, cheap; least thinking before answering" },
  { id: "medium", description: "balanced (default)" },
  { id: "high", description: "most thorough; more thinking, slower and more tokens" },
  {
    id: "xhigh",
    description: "extended reasoning; only some models honor it (e.g. Muse), else same as high",
  },
];

export const DEFAULT_EFFORT: EffortLevel = "medium";

/** Resolve a typed `/effort <arg>` or `--effort` value to a level: exact id or an
 * unambiguous prefix (`l`→low, `m`→medium, `h`→high), else null. */
export function resolveEffortName(arg: string): EffortLevel | null {
  const a = arg.trim().toLowerCase();
  if (!a) return null;
  const exact = EFFORTS.find((e) => e.id === a);
  if (exact) return exact.id;
  const prefixed = EFFORTS.filter((e) => e.id.startsWith(a));
  return prefixed.length === 1 ? prefixed[0]!.id : null;
}

/** Resolve the startup level from the config default + an optional `--effort` flag.
 * Unknown flag → ignored with a warning. Pure; the caller emits the warnings. */
export function resolveStartEffort(
  configDefault: EffortLevel,
  flag: string | undefined,
): { effort: EffortLevel; warnings: string[] } {
  const warnings: string[] = [];
  let effort = configDefault;
  if (flag) {
    const parsed = resolveEffortName(flag);
    if (!parsed) warnings.push(`unknown --effort '${flag}', ignoring`);
    else effort = parsed;
  }
  return { effort, warnings };
}

/** Autocomplete candidates for a `/effort <partial>` line (mirrors completePersonaLine). */
export function completeEffortLine(line: string): { display: string; value: string }[] {
  const m = /^\/effort\s+(.*)$/.exec(line);
  if (!m) return [];
  const partial = m[1]!.toLowerCase();
  return EFFORTS.filter((e) => e.id.includes(partial)).map((e) => ({
    display: `${e.id} — ${e.description}`,
    value: `/effort ${e.id}`,
  }));
}

/** The value sent on the OpenAI-standard `reasoning_effort` body param, whose enum is
 *  `low|medium|high`. `xhigh` is a family-specific extended tier carried by the prompt directive,
 *  so on the wire it clamps to `high`. */
function wireEffort(level: EffortLevel): "low" | "medium" | "high" {
  return level === "xhigh" ? "high" : level;
}

/** Append `line` to the first system message, or prepend a new system message when the request
 * carries none. Returns a new array and new message objects — never mutates the caller's messages. */
function appendSystemLine(messages: Message[], line: string): Message[] {
  const idx = messages.findIndex((m) => m.role === "system");
  if (idx === -1) {
    return [{ role: "system", content: line }, ...messages];
  }
  return messages.map((m, i) =>
    i === idx ? { ...m, content: m.content ? `${m.content}\n\n${line}` : line } : m,
  );
}

/** Decorate a chat request with the active reasoning-effort dial:
 *  - set reasoningEffort (universal OpenAI-standard param, wire-clamped: `xhigh`→`high`) UNLESS the
 *    model can't think — its family declares `supportsReasoning: false` (granite) or it is in the
 *    session `noThink` set (a model that 400'd with "does not support thinking"). Sending it to
 *    those models makes Ollama reject the request, so it is omitted (LM Studio ignores it anyway).
 *  - if the model's family declares a `reasoningDirective`, append its system-prompt line (creating
 *    a system message if absent). gpt-oss emits harmony `Reasoning: <level>`; muse emits `Reasoning
 *    strength: <level>` (the only path that carries `xhigh` to the model).
 * Pure: returns a new ChatOptions, does not mutate the input. */
export function applyEffort(
  req: ChatOptions,
  level: EffortLevel,
  noThink?: ReadonlySet<string>,
): ChatOptions {
  const family = detectFamily(req.model, req.modelFamily?.override);
  const supportsReasoning = family?.supportsReasoning !== false && !noThink?.has(req.model);
  const decorated: ChatOptions = supportsReasoning
    ? { ...req, reasoningEffort: wireEffort(level) }
    : { ...req };
  const directive = family?.reasoningDirective?.(level);
  if (directive) {
    decorated.messages = appendSystemLine(req.messages, directive);
  }
  return decorated;
}
