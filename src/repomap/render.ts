import type { FileSymbols } from "./types";

/** Cheap token estimate — no tokenizer dependency. Conservative enough for a budget guard. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function renderBlock(file: FileSymbols): string {
  const lines = [file.path];
  for (const s of file.symbols) lines.push(`  ${s.name} (${s.kind}) :${s.line}`);
  return lines.join("\n");
}

export function renderMap(ranked: FileSymbols[], tokenBudget: number): string {
  if (ranked.length === 0) return "";
  const header = "## Repository map";
  const out = [header];
  let used = estimateTokens(header);
  let i = 0;
  for (; i < ranked.length; i++) {
    const block = renderBlock(ranked[i]!);
    const cost = estimateTokens(`\n${block}`);
    // out.length > 1 guarantees at least one file is always rendered.
    if (out.length > 1 && used + cost > tokenBudget) break;
    out.push(block);
    used += cost;
  }
  const remaining = ranked.length - i;
  if (remaining > 0) out.push(`… ${remaining} more files`);
  return out.join("\n");
}

/** Truncate an already-rendered map to a smaller token budget, cutting on line boundaries
 *  (WS5: small capability serves half the configured repo-map budget without a rebuild). */
export function truncateMapToBudget(map: string, tokenBudget: number): string {
  if (!map || estimateTokens(map) <= tokenBudget) return map;
  const lines = map.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const t = estimateTokens(`${line}\n`);
    if (used + t > tokenBudget) break;
    kept.push(line);
    used += t;
  }
  return kept.join("\n");
}
