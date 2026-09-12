import type { Message } from "../types";
import { toOpenAIMessage } from "../wire";
import type { ModelFamilyName, SamplingDefaults } from "./types";

/** Recommended sampling per family (applied only to caller-undefined fields). */
export const SAMPLING: Record<ModelFamilyName, SamplingDefaults> = {
  qwen: { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.0 },
  "gpt-oss": { temperature: 1.0, topP: 1.0 },
  gemma: { temperature: 1.0, topP: 0.95, topK: 64 },
  granite: { temperature: 0.0 },
  glm: { temperature: 0.6, topP: 0.95 },
  cohere: { temperature: 1.0, topP: 0.95 },
  // Conservative profile pending Muse-specific guidance — matches the generic fallback the Muse
  // line ran under before it had a family, so registering it does not shift sampling.
  muse: { temperature: 0.6, topP: 0.95, presencePenalty: 0.5 },
};

/** Standard mapping — drops reasoning from the wire (every family except gpt-oss). */
export function buildMessagesDefault(messages: Message[]): unknown[] {
  return messages.map((m) => toOpenAIMessage(m));
}

/** gpt-oss: include assistant chain-of-thought on the wire (facet #4). */
export function buildMessagesGptOss(messages: Message[]): unknown[] {
  return messages.map((m) => toOpenAIMessage(m, { includeReasoning: true }));
}

/** Gemma: no system role — fold all system content into the first user message (facet #2). */
export function buildMessagesGemma(messages: Message[]): unknown[] {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  if (!systemText) return rest.map((m) => toOpenAIMessage(m));
  const firstUserIdx = rest.findIndex((m) => m.role === "user");
  if (firstUserIdx === -1) {
    return [{ role: "user", content: systemText }, ...rest.map((m) => toOpenAIMessage(m))];
  }
  return rest.map((m, i) =>
    i === firstUserIdx
      ? toOpenAIMessage({ ...m, content: `${systemText}\n\n${m.content}` })
      : toOpenAIMessage(m),
  );
}

/** Conservative fallback for models no family matches (renamed/merged/quantized GGUFs are
 *  the most common local-model case): repetition-resistant sampling applied only when the
 *  family system is enabled and detection missed. Caller-supplied values still win. */
const FALLBACK_SAMPLING: SamplingDefaults = { temperature: 0.6, topP: 0.95, presencePenalty: 0.5 };

/** A fresh copy, mirroring FamilyAdapter.defaultParams() so callers cannot mutate the table. */
export function fallbackParams(): SamplingDefaults {
  return { ...FALLBACK_SAMPLING };
}
