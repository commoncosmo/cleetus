import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../../config/loader";
import type { EventSource } from "../../events/log";
import { explainReport, selectSamples } from "../../insights/explain";
import { formatReport, toJson } from "../../insights/format";
import { openEventSource } from "../../insights/reader";
import { analyze, collectTrajectories } from "../../insights/report";
import { buildProvider } from "../../providers/factory";

export interface AnalyzeIo {
  write: (s: string) => void;
  writeErr: (s: string) => void;
}

/** Parse a relative duration like 7d / 24h / 30m into milliseconds. Null if invalid. */
function parseDurationMs(input: string): number | null {
  const m = /^(\d+)([dhm])$/.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as "d" | "h" | "m"];
  return n * unit;
}

const EMPTY_SOURCE: EventSource = { listSessions: () => [], query: () => [] };

/**
 * `cleetus analyze` — read-only insights over .cleetus/sessions.db.
 * argv is the full process argv (or any array containing the "analyze" token).
 */
export async function runAnalyze(
  argv: string[],
  projectDir: string,
  io: AnalyzeIo,
): Promise<number> {
  const idx = argv.indexOf("analyze");
  const rest = idx >= 0 ? argv.slice(idx + 1) : argv;

  const prog = new Command();
  prog
    .name("cleetus analyze")
    .description("Analyze recorded sessions and tool usage")
    .option("--since <dur>", "only turns newer than e.g. 7d, 24h, 30m")
    .option("--session <id>", "restrict to a single session")
    .option("--json", "emit the InsightsReport as JSON")
    .option("--explain", "append an LLM narrative of suggestions")
    .option("--model <name>", "model for --explain (defaults to the configured default)")
    .allowExcessArguments()
    .exitOverride(); // return an exit code instead of letting commander call process.exit()
  try {
    prog.parse(rest, { from: "user" });
  } catch (e) {
    // commander already wrote help/error output; surface its exit code (0 for --help)
    return (e as { exitCode?: number }).exitCode ?? 1;
  }
  const o = prog.opts<{
    since?: string;
    session?: string;
    json?: boolean;
    explain?: boolean;
    model?: string;
  }>();

  let since: number | undefined;
  if (o.since != null) {
    const ms = parseDurationMs(o.since);
    if (ms == null) {
      io.writeErr(`invalid --since value '${o.since}' (use e.g. 7d, 24h, 30m)\n`);
      return 2;
    }
    since = Date.now() - ms;
  }

  const dbPath = join(projectDir, ".cleetus", "sessions.db");
  const source = openEventSource(dbPath) ?? EMPTY_SOURCE;
  const filter = { since, sessionId: o.session };
  const report = analyze(source, filter);

  if (o.json) {
    if (o.explain) io.writeErr("--explain ignored with --json\n");
    io.write(`${toJson(report)}\n`);
    return 0;
  }

  if (o.session && report.trajectoryCount === 0) {
    io.write(`no turns found for session '${o.session}'\n`);
    return 0;
  }
  io.write(`${formatReport(report)}\n`);

  if (o.explain) {
    // Global config path mirrors cleetus.ts (a module-local const there, not exported).
    const GLOBAL_CONFIG = join(homedir(), ".config", "cleetus", "config.yaml");
    const config = await loadConfig({ globalPath: GLOBAL_CONFIG, projectDir });
    const providerName = config.defaultProvider ?? Object.keys(config.providers)[0]; // insertion-order fallback, mirrors cleetus.ts startup
    const model = o.model ?? config.defaultModel;
    const pcfg = providerName ? config.providers[providerName] : undefined;
    if (!pcfg || !model) {
      io.writeErr("--explain skipped: no provider/model configured\n");
      return 0;
    }
    try {
      const provider = buildProvider(pcfg.type, pcfg.baseUrl, pcfg.apiKey);
      const samples = selectSamples(report, collectTrajectories(source, filter));
      const prose = await explainReport(report, samples, provider, model);
      if (prose.trim()) io.write(`\n## Suggestions\n${prose}\n`);
    } catch (e) {
      io.writeErr(`--explain skipped: ${(e as Error).message}\n`);
    }
  }

  return 0;
}
