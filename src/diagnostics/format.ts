import type { CheckStatus, Diagnostic } from "./types";

export interface FormatInput {
  providerId: string;
  status: CheckStatus;
  newDiagnostics: Diagnostic[];
  fixedCount: number;
  maxReported: number;
  timeoutMs: number;
}

function severityRank(d: Diagnostic): number {
  return d.severity === "error" ? 0 : 1;
}

function line(d: Diagnostic): string {
  const loc = `${d.file}:${d.line}`;
  const code = d.code ? `  ${d.code}` : "";
  return `  ${loc}${code}  ${d.message}`;
}

/** Render a CheckReport's model-facing text. */
export function formatReport(input: FormatInput): string {
  if (input.status === "timeout") {
    const secs = Math.round(input.timeoutMs / 1000);
    return `⚠ ${input.providerId} diagnostics timed out (${secs}s) — skipped`;
  }
  if (input.status === "unavailable") {
    return `⚠ ${input.providerId} diagnostics unavailable — skipped`;
  }
  if (input.status === "no_baseline") {
    const fresh = [...input.newDiagnostics].sort((a, b) => severityRank(a) - severityRank(b));
    if (fresh.length === 0) return `✓ ${input.providerId}: no diagnostics in the edited file(s)`;
    const shown = fresh.slice(0, input.maxReported);
    const overflow = fresh.length - shown.length;
    const lines = [
      `⚠ ${fresh.length} diagnostics in the edited file(s) (${input.providerId}, no baseline — showing all)`,
      ...shown.map(line),
    ];
    if (overflow > 0) lines.push(`  …and ${overflow} more`);
    return lines.join("\n");
  }
  // status === "ok"
  const fresh = [...input.newDiagnostics].sort((a, b) => severityRank(a) - severityRank(b));
  if (fresh.length === 0) {
    const fixed = input.fixedCount > 0 ? ` (✓ fixed ${input.fixedCount} pre-existing)` : "";
    return `✓ ${input.providerId}: no new diagnostics${fixed}`;
  }
  const shown = fresh.slice(0, input.maxReported);
  const overflow = fresh.length - shown.length;
  const lines = [`⚠ ${fresh.length} new diagnostics (${input.providerId})`, ...shown.map(line)];
  if (overflow > 0) lines.push(`  …and ${overflow} more`);
  if (input.fixedCount > 0)
    lines.push(
      `  ✓ also fixed ${input.fixedCount} pre-existing issue${input.fixedCount === 1 ? "" : "s"}`,
    );
  return lines.join("\n");
}
