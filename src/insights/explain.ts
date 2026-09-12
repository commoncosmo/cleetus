import type { Message, Provider } from "../providers/types";
import { EXPLAIN_SAMPLE_CAP } from "./constants";
import { toJson } from "./format";
import type { InsightsReport } from "./report";
import type { Trajectory } from "./trajectory";

const SYSTEM_PROMPT =
  "You are analyzing an AI coding agent's own usage logs. Given the metrics and the " +
  "sample failed trajectories, propose specific, terse prompt/tool/policy changes that " +
  "would improve the agent. Use short bullet points. Do not restate the metrics.";

/**
 * Rank worst offenders: loop_limit turns and turns with failing tool calls, capped.
 * `_report` is unused today but kept in the signature: Phase 5B/5C will weight sample
 * selection against the aggregate metrics (e.g. a tool's overall failure rate), and the
 * CLI/TUI call sites already hold the report — keeping it here avoids a later API churn.
 */
export function selectSamples(_report: InsightsReport, trajectories: Trajectory[]): Trajectory[] {
  const scored = trajectories
    .map((t) => {
      const failures = t.toolCalls.filter((c) => !c.ok).length;
      const loopPenalty = t.outcome === "loop_limit" ? 100 : 0;
      return { t, score: failures + loopPenalty };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score); // equal scores keep input order (chronological) via stable sort
  return scored.slice(0, EXPLAIN_SAMPLE_CAP).map((s) => s.t);
}

function serializeSample(t: Trajectory): string {
  const tools = t.toolCalls
    .map((c) => `${c.name}${c.ok ? "" : ` FAILED: ${c.errorMessage ?? "?"}`}`)
    .join(", ");
  return `- input: ${t.userInput.slice(0, 200)} | outcome: ${t.outcome} | loops: ${t.loopCount} | tools: ${tools}`;
}

/** One tool-less synthesis call. Purely additive; the caller falls back to metrics on throw. */
export async function explainReport(
  report: InsightsReport,
  samples: Trajectory[],
  provider: Provider,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return "";

  const userContent =
    `Metrics (JSON):\n${toJson(report)}\n\n` +
    `Sample worst-offender turns:\n${samples.map(serializeSample).join("\n") || "(none)"}`;

  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  let text = "";
  for await (const ev of provider.chat({ model, messages, signal })) {
    if (signal?.aborted) break; // stop early even if the provider doesn't honor the signal itself
    if (ev.type === "text-delta") text += ev.text;
  }
  return text;
}
