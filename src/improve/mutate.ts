import { toJson } from "../insights/format";
import type { InsightsReport } from "../insights/report";
import type { Trajectory } from "../insights/trajectory";
import type { Message, Provider } from "../providers/types";

export interface PromptVariant {
  name: string;
  instructions: string;
}

export interface MutateDeps {
  baseInstructions: string;
  globalContext: string;
  memoriesContext: string;
  report: InsightsReport;
  samples: Trajectory[];
  provider: Provider;
  model: string;
  count: number;
  signal?: AbortSignal;
}

const SYSTEM_PROMPT =
  "You are improving the operating instructions (system prompt) of an AI coding agent. " +
  "You will get the CURRENT instructions, METRICS showing where the agent fails, and SAMPLE " +
  "FAILING RUNS. Output a REVISED instructions block that fixes the weaknesses while preserving " +
  "the existing instructions and strengths. The global instructions and memories shown are FIXED " +
  "CONTEXT — do not reproduce them. Output ONLY the revised instructions block — no commentary.";

const GENERIC_FOCUS = "improve the agent's overall effectiveness";

/** Weakness-focused hints derived from the 5A report, to diversify the K variants. */
export function focusHints(report: InsightsReport): string[] {
  const hints: string[] = [];
  const worstTool = report.toolReliability.tools.find((t) => t.failures > 0);
  if (worstTool) {
    hints.push(
      `the ${worstTool.tool} tool fails ${(worstTool.failureRate * 100).toFixed(0)}% of the time — make its usage more reliable`,
    );
  }
  if (report.turnEfficiency.outcomes.loop_limit > 0) {
    hints.push(
      "turns sometimes hit the tool-call limit — guide the agent to plan and converge faster",
    );
  }
  if (report.turnEfficiency.outcomes.error > 0) {
    hints.push("some turns end in errors — add guidance to handle tool failures gracefully");
  }
  return hints;
}

function serializeSamples(samples: Trajectory[]): string {
  const lines = samples.map((t) => {
    const tools = t.toolCalls.map((c) => `${c.name}${c.ok ? "" : " FAILED"}`).join(", ");
    return `- input: ${t.userInput.slice(0, 200)} | outcome: ${t.outcome} | loops: ${t.loopCount} | tools: ${tools}`;
  });
  return lines.join("\n") || "(none)";
}

/** Generate up to `count` revised instruction blocks via K tool-less LLM calls. */
export async function proposeCandidates(deps: MutateDeps): Promise<PromptVariant[]> {
  const hints = focusHints(deps.report);
  const baseline = deps.baseInstructions.trim();
  const variants: PromptVariant[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < deps.count; i++) {
    if (deps.signal?.aborted) break;
    const focus = i < hints.length ? hints[i]! : GENERIC_FOCUS;
    const userContent =
      `CURRENT INSTRUCTIONS (you may revise this block):\n${deps.baseInstructions || "(empty)"}\n\n` +
      `FIXED CONTEXT — global instructions (do not reproduce):\n${deps.globalContext || "(none)"}\n\n` +
      `FIXED CONTEXT — memories (do not reproduce):\n${deps.memoriesContext || "(none)"}\n\n` +
      `METRICS (JSON):\n${toJson(deps.report)}\n\n` +
      `SAMPLE FAILING RUNS:\n${serializeSamples(deps.samples)}\n\n` +
      `FOCUS FOR THIS VARIANT: ${focus}`;
    const messages: Message[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];

    let text = "";
    try {
      for await (const ev of deps.provider.chat({
        model: deps.model,
        messages,
        signal: deps.signal,
      })) {
        if (deps.signal?.aborted) break;
        if (ev.type === "text-delta") text += ev.text;
      }
    } catch {
      continue; // skip a failed variant call
    }
    if (deps.signal?.aborted) break; // a mid-stream abort must not push a partial variant

    const instructions = text.trim();
    if (!instructions || instructions === baseline || seen.has(instructions)) continue;
    seen.add(instructions);
    variants.push({ name: `mut-${variants.length + 1}`, instructions });
  }

  return variants;
}
