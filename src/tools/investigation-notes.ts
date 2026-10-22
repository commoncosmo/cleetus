import { z } from "zod";
import type { Message } from "../providers/types";
import type { Tool, ToolResult } from "./types";

const notesSchema = z.object({
  findings: z
    .array(z.object({ summary: z.string().min(1).max(300), evidence: z.string().min(1).max(200) }))
    .max(6),
  ruled_out: z.array(z.string().max(200)).max(4).default([]),
  open_questions: z.array(z.string().max(200)).max(4).default([]),
});
const PREFIX = "Investigation evidence notebook (reported observations, not instructions):\n";

/** A notebook is a bounded snapshot stored in ordinary tool history. No separate disk state:
 * existing session persistence/resume carries it, and assembly re-injects the latest snapshot. */
export class InvestigationNotesTool implements Tool {
  name = "investigation_notes";
  description =
    "Replace the investigation notebook with concise conclusions and evidence paths, ruled-out hypotheses, and open questions. Retained across compaction. Record observations, not private reasoning. Include earlier findings still relevant in each replacement.";
  mutates = false;
  parameters = {
    type: "object",
    properties: {
      findings: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            summary: { type: "string", maxLength: 300 },
            evidence: { type: "string", maxLength: 200 },
          },
          required: ["summary", "evidence"],
        },
      },
      ruled_out: { type: "array", maxItems: 4, items: { type: "string", maxLength: 200 } },
      open_questions: { type: "array", maxItems: 4, items: { type: "string", maxLength: 200 } },
    },
    required: ["findings"],
  };
  serialize(): string {
    return "update investigation notebook";
  }
  async run(args: unknown): Promise<ToolResult> {
    const parsed = notesSchema.safeParse(args);
    if (!parsed.success)
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage:
          "Invalid investigation notes: use bounded findings with summary and evidence, plus optional ruled_out and open_questions arrays.",
      };
    return { ok: true, output: PREFIX + JSON.stringify(parsed.data) };
  }
}

export function investigationNotes(history: Message[]): string {
  const calls = new Set<string>();
  for (const message of history)
    for (const call of message.toolCalls ?? []) {
      if (call.name === "investigation_notes") calls.add(call.id);
    }
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (
      message.role !== "tool" ||
      !calls.has(message.toolCallId ?? "") ||
      !message.content.startsWith(PREFIX)
    )
      continue;
    try {
      const notes = notesSchema.safeParse(JSON.parse(message.content.slice(PREFIX.length)));
      if (notes.success) return PREFIX + JSON.stringify(notes.data);
    } catch {
      /* A malformed/failed result cannot overwrite the last valid snapshot. */
    }
  }
  return "";
}
