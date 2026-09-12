import type { EffortLevel } from "../../agent/effort";
import { SAMPLING, buildMessagesDefault, buildMessagesGemma, buildMessagesGptOss } from "./shape";
import type { FamilyAdapter } from "./types";

/** Harmony exposes low/medium/high only; the Muse-specific `xhigh` clamps to `high`. */
const harmonyLevel = (level: EffortLevel): string => (level === "xhigh" ? "high" : level);

/** The supported families, in detection order. Substring match is case-insensitive.
 *  defaultParams() returns a COPY so callers can't mutate the shared SAMPLING table. */
export const FAMILIES: FamilyAdapter[] = [
  {
    name: "gpt-oss",
    matches: (id) => id.toLowerCase().includes("gpt-oss"),
    defaultParams: () => ({ ...SAMPLING["gpt-oss"] }),
    buildMessages: buildMessagesGptOss,
    preferredFormat: "harmony",
    reasoningDirective: (level) => `Reasoning: ${harmonyLevel(level)}`,
  },
  {
    name: "qwen",
    matches: (id) => id.toLowerCase().includes("qwen"),
    defaultParams: () => ({ ...SAMPLING.qwen }),
    buildMessages: buildMessagesDefault,
    preferredFormat: "qwen-xml",
  },
  {
    name: "gemma",
    matches: (id) => id.toLowerCase().includes("gemma"),
    defaultParams: () => ({ ...SAMPLING.gemma }),
    buildMessages: buildMessagesGemma,
    preferredFormat: "hermes-json",
  },
  {
    name: "granite",
    matches: (id) => id.toLowerCase().includes("granite"),
    defaultParams: () => ({ ...SAMPLING.granite }),
    buildMessages: buildMessagesDefault,
    preferredFormat: "granite",
    // Granite has no thinking mode; Ollama 400s on a reasoning request ("does not support thinking").
    supportsReasoning: false,
  },
  {
    name: "glm",
    matches: (id) => id.toLowerCase().includes("glm"),
    defaultParams: () => ({ ...SAMPLING.glm }),
    buildMessages: buildMessagesDefault,
    preferredFormat: "glm",
    // <|observation|> is GLM's tool-result delimiter and must stop generation, else the model
    // loops it in the text channel (forensic #7). These are GLM's chat-template stop tokens.
    stopSequences: ["<|observation|>", "<|user|>", "<|assistant|>", "<|endoftext|>"],
  },
  {
    name: "cohere",
    matches: (id) => {
      const s = id.toLowerCase();
      // `north-` (not bare `north`) so the North-* series matches without claiming unrelated
      // ids like `northstar`/`northern-…`.
      return (
        s.includes("cohere") ||
        s.includes("north-") ||
        s.includes("command-r") ||
        s.includes("command-a")
      );
    },
    defaultParams: () => ({ ...SAMPLING.cohere }),
    buildMessages: buildMessagesDefault,
    preferredFormat: "cohere",
  },
  {
    name: "muse",
    // The Meta Muse line (Muse-Glimmer, Muse-Spark, future muse-*). A word-boundary guard (like
    // cohere's `north-`) so a stray `amuse`/`bemused` id can't claim the family.
    matches: (id) => /(?:^|[\s/_-])muse/i.test(id),
    defaultParams: () => ({ ...SAMPLING.muse }),
    buildMessages: buildMessagesDefault,
    // Muse's true tool format is unknown; "harmony" is ALL_FORMATS[0], so recovery sniffs in the
    // exact order the unmatched fallback used — non-regressive. The family exists chiefly to carry
    // the reasoning directive below.
    preferredFormat: "harmony",
    // Muse controls effort via a `Reasoning strength: <level>` system line and honors all four
    // tiers, including xhigh (unlike the OpenAI reasoning_effort body param).
    reasoningDirective: (level) => `Reasoning strength: ${level}`,
  },
];

/** Union of every registered family's stop sequences — template delimiters no correct
 *  completion should emit, safe to apply to an unrecognized model so a family derivative
 *  whose id doesn't substring-match (e.g. a renamed GLM) still halts at its delimiters. */
export function fallbackStopSequences(): string[] {
  const seen = new Set<string>();
  for (const f of FAMILIES) {
    for (const s of f.stopSequences ?? []) seen.add(s);
  }
  return [...seen];
}
