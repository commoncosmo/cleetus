import type { EventSource } from "../events/log";
import { explainReport, selectSamples } from "../insights/explain";
import { formatReport } from "../insights/format";
import { analyze, collectTrajectories } from "../insights/report";
import type { Provider } from "../providers/types";

const DURATIONS = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
} as const;

export interface AcpInsightsDeps {
  source: EventSource;
  sessionId: string;
  args: string;
  signal?: AbortSignal;
  explain?: () => { provider: Provider; model: string };
  now?: () => number;
}

/** ACP's session-scoped insights frontend. Unlike the terminal-wide report, this never crosses
 * session boundaries: one ACP connection may serve sessions rooted in different projects. */
export async function runAcpInsights(deps: AcpInsightsDeps): Promise<string> {
  const tokens = deps.args.split(/\s+/).filter(Boolean);
  const wantExplain = tokens.includes("explain");
  const sinceIndex = tokens.indexOf("since");
  let since: number | undefined;

  if (sinceIndex >= 0) {
    const value = tokens[sinceIndex + 1];
    if (!value) return "'since' requires a value (e.g. since 7d, since 24h, since 30m)";
    const match = /^(\d+)([dhm])$/.exec(value);
    if (!match) return `invalid 'since' value '${value}' (use e.g. 7d, 24h, 30m)`;
    const unit = DURATIONS[match[2] as keyof typeof DURATIONS];
    since = (deps.now?.() ?? Date.now()) - Number(match[1]) * unit;
  }

  const filter = { sessionId: deps.sessionId, since };
  const report = analyze(deps.source, filter);
  let output =
    report.trajectoryCount === 0
      ? `no turns found for session '${deps.sessionId}'`
      : formatReport(report);

  if (!wantExplain || report.trajectoryCount === 0) return output;
  if (!deps.explain) return `${output}\n\nexplain skipped: no provider/model configured`;

  try {
    const { provider, model } = deps.explain();
    const samples = selectSamples(report, collectTrajectories(deps.source, filter));
    const prose = await explainReport(report, samples, provider, model, deps.signal);
    if (prose.trim()) output += `\n\n## Suggestions\n${prose}`;
  } catch (error) {
    output += `\n\nexplain skipped: ${(error as Error).message}`;
  }
  return output;
}
