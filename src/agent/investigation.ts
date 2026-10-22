import type { ToolResult } from "../tools/types";

/** Deliberately narrow: only source analysis requests, never approval/implementation turns. */
export function isCodeInvestigation(input: string): boolean {
  const requestedActions = input.replace(
    /\b(?:do not|don't|never|without)\s+(?:implement|fix|change|edit|build|write|refactor|patch)\b/gi,
    "",
  );
  if (/\b(implement|fix|change|edit|build|write|refactor|patch)\b/i.test(requestedActions))
    return false;
  return (
    /\b(review|investigate|inspect|analy[sz]e|look at|take a look|recommend)\b/i.test(input) &&
    /\b(code|codebase|source|runtime|context|compaction|repository|cleetus)\b/i.test(input)
  );
}

/** Defer browser schemas only for source-only reviews. Other configured integrations remain
 * visible, and browser/UI requests keep their full surface and existing permissions. */
export function investigationToolSurface<T extends { name: string }>(
  tools: T[],
  input: string,
): T[] {
  if (
    !isCodeInvestigation(input) ||
    /\b(browser|playwright|web|website|page|render\w*|visual|screenshot|ui)\b/i.test(input)
  )
    return tools;
  return tools.filter((tool) => !/^mcp__.*__browser_/.test(tool.name));
}

export const INVESTIGATION_REMINDER =
  "<system-reminder>Perform a focused source investigation. Use code_search for conceptual discovery when an index is available; use targeted grep for exact symbols or when embeddings fail. Read relevant ranges and batch independent reads. Record established conclusions, evidence locations, ruled-out hypotheses, and remaining questions with investigation_notes before context compaction or further exploration. Do not repeat unchanged reads merely to rediscover a conclusion. Once evidence supports an answer, report prioritized findings and uncertainties; investigation does not require editing files.</system-reminder>";

/** Track normalized source-line evidence rather than command spellings. Only sizable successful
 * inspection results participate. Four mostly repeated results trigger a bounded synthesis;
 * genuine new evidence resets the streak. This is turn-local and never blocks an implementation. */
export class InvestigationGuard {
  private seen = new Set<string>();
  private seenLines = new Set<string>();
  private repeats = 0;

  observe(name: string, result: Pick<ToolResult, "ok" | "output">): "warn" | "finish" | null {
    if (!result.ok || !["read_file", "bash", "grep", "glob", "code_search"].includes(name))
      return null;
    const text = result.output ?? "";
    if (text.length < 400) return null;
    const lines = text
      .slice(0, 64_000)
      .split("\n")
      .map((line) => line.replace(/^\s*\d+\s+/, "").trim())
      .filter((line) => line.length >= 16);
    if (lines.length < 8) return null;
    // Adjacent lines reduce false positives from common imports/braces/boilerplate.
    const evidence = lines.slice(1).map((line, i) => `${lines[i]}\n${line}`);
    const known = evidence.filter((line) => this.seen.has(line)).length;
    const novelLine = lines.some((line) => !this.seenLines.has(line));
    for (const line of lines) {
      this.seenLines.add(line);
      if (this.seenLines.size > 4096) this.seenLines.delete(this.seenLines.values().next().value!);
    }
    for (const line of evidence) {
      this.seen.add(line);
      if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    }
    this.repeats = !novelLine && known / evidence.length >= 0.85 ? this.repeats + 1 : 0;
    if (this.repeats >= 4) return "finish";
    return this.repeats === 2 ? "warn" : null;
  }
}
