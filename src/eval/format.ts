import type { Comparison } from "./types";

export function toJson(comparison: Comparison): string {
  return JSON.stringify(comparison, null, 2);
}

export function formatComparison(comparison: Comparison): string {
  if (comparison.ranked.length === 0) return "no eval runs";

  const base = comparison.ranked.find((c) => c.candidate === comparison.baseline);
  const lines: string[] = [];
  lines.push("Eval results (best first)");
  lines.push("");

  comparison.ranked.forEach((c, i) => {
    const tag = i === 0 ? "  ★ winner" : "";
    const delta =
      base && c.candidate !== comparison.baseline
        ? ` Δ failures ${signed(c.totalToolFailures - base.totalToolFailures)},` +
          ` loops ${signed(c.totalLoops - base.totalLoops)},` +
          ` tokens ${signed(c.totalTokens - base.totalTokens)}`
        : "";
    lines.push(
      `  ${c.candidate}: ${c.passed}/${c.scenariosRun} passed · ` +
        `${c.totalToolFailures} tool failures · ${c.totalLoops} loops · ${c.totalTokens} tokens${tag}`,
    );
    if (delta) lines.push(`     ${delta.trim()}`);
  });

  return lines.join("\n");
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
