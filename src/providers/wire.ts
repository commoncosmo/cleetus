import { readFileSync } from "node:fs";
import type { ImageRef, Message } from "./types";

/** Serialize each image to an `image_url` part, skipping any whose file can no longer be read
 *  (moved/deleted attachment) rather than throwing and killing the whole turn. */
function imageParts(images: ImageRef[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const img of images) {
    let base64: string;
    try {
      base64 = readFileSync(img.path).toString("base64");
    } catch {
      continue;
    }
    parts.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${base64}` } });
  }
  return parts;
}

/** Serialize a cleetus Message to an OpenAI-compatible wire message.
 *  `includeReasoning` attaches the assistant turn's chain-of-thought as a `reasoning`
 *  field (gpt-oss CoT pass-through, facet #4); servers that don't expect it ignore it. */
export function toOpenAIMessage(m: Message, opts?: { includeReasoning?: boolean }): unknown {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  const extra: Record<string, unknown> = {};
  if (opts?.includeReasoning && m.role === "assistant" && m.reasoning) {
    extra.reasoning = m.reasoning;
  }
  if (m.toolCalls?.length) {
    return {
      role: m.role,
      content: m.content || null,
      ...extra,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
      })),
    };
  }
  if (m.images?.length && (m.role === "user" || m.role === "assistant")) {
    return {
      role: m.role,
      content: [{ type: "text", text: m.content }, ...imageParts(m.images)],
      ...extra,
    };
  }
  return { role: m.role, content: m.content, ...extra };
}
