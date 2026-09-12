import { REASONING_CHARS_PER_TOKEN, type ReasoningBucket } from "./analyzers/reasoning-cost";
import type { InsightsReport } from "./report";

export function toJson(report: InsightsReport): string {
  return JSON.stringify(report, null, 2);
}

/** 850 → "850", 12_340 → "12.3k". Token counts here are estimates, so one decimal is plenty. */
function compactCount(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

const pct = (share: number): string => `${Math.round(share * 100)}%`;

/** "small 58% / large 71%" — tiers with calls but no usage show "?" rather than vanishing. */
function tierShares(tiers: Record<string, ReasoningBucket>): string {
  return Object.entries(tiers)
    .filter(([, b]) => b.calls > 0)
    .map(([tier, b]) => `${tier} ${b.reasoningShare === null ? "?" : pct(b.reasoningShare)}`)
    .join(" / ");
}

export function formatReport(report: InsightsReport): string {
  if (report.trajectoryCount === 0) return "no sessions recorded yet";

  const lines: string[] = [];
  lines.push(`Insights — ${report.trajectoryCount} turns across ${report.sessionCount} session(s)`);

  lines.push("", "## Tool reliability");
  if (report.toolReliability.tools.length === 0) {
    lines.push("  (no tool calls)");
  } else {
    for (const t of report.toolReliability.tools) {
      const pct = (t.failureRate * 100).toFixed(0);
      lines.push(`  ${t.tool}: ${t.calls} calls, ${t.failures} failed (${pct}%)`);
      for (const e of t.topErrors) lines.push(`      - ${e.count}x ${e.message}`);
    }
  }

  const te = report.turnEfficiency;
  lines.push("", "## Turn efficiency");
  lines.push(`  ${te.totalTurns} turns · avg ${te.avgLoops.toFixed(1)} loops · max ${te.maxLoops}`);
  lines.push(
    `  outcomes: ok=${te.outcomes.ok} error=${te.outcomes.error} ` +
      `cancelled=${te.outcomes.cancelled} loop_limit=${te.outcomes.loop_limit}`,
  );

  lines.push("", "## Permission patterns");
  if (report.permissionPatterns.suggestions.length === 0) {
    lines.push("  (no allowlist suggestions)");
  } else {
    for (const s of report.permissionPatterns.suggestions) {
      lines.push(`  ${s.tool} — ${s.argsSummary}: ${s.reason}`);
    }
  }

  const rc = report.routingCost;
  lines.push("", "## Routing & cost");
  lines.push(
    `  tiers: small=${rc.tierUsage.small} large=${rc.tierUsage.large} ` +
      `untiered=${rc.tierUsage.untiered} · escalations=${rc.escalations} · ` +
      `finish passes=${rc.finishPasses}`,
  );
  const causes = Object.entries(rc.escalationsByReason).sort((a, b) => b[1] - a[1]);
  if (causes.length > 0) {
    lines.push(`  by cause: ${causes.map(([cause, count]) => `${cause}=${count}`).join(", ")}`);
  }
  lines.push(
    rc.totalTokens
      ? `  tokens: ${rc.totalTokens.input} in / ${rc.totalTokens.output} out`
      : "  tokens: not reported",
  );

  // Only when some call actually emitted a reasoning channel — most models don't, and an
  // all-zero table would just be noise for them.
  const rsn = report.reasoningCost;
  if (rsn.hasReasoning) {
    lines.push(
      "",
      `## Reasoning (est. from reasoning text at ~${REASONING_CHARS_PER_TOKEN} chars/token)`,
    );
    const rows = Object.entries(rsn.byTaskClass)
      .filter(([, b]) => b.calls > 0)
      .sort((a, b) => b[1].estReasoningTokens - a[1].estReasoningTokens);
    for (const [taskClass, b] of rows) {
      const share =
        b.reasoningShare === null ? "share n/a" : `≈ ${pct(b.reasoningShare)} of output`;
      lines.push(
        `  ${taskClass}: ${b.calls} calls (${b.callsWithReasoning} thought) · ` +
          `~${compactCount(b.estReasoningTokens)} tok ${share} · ${tierShares(b.tiers)} · ` +
          `${b.turns} turn${b.turns === 1 ? "" : "s"} (${b.okTurns} ok)`,
      );
    }
  }

  return lines.join("\n");
}
