import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { resolveStartRouteMode } from "../../agent/route-modes";
import { loadConfig } from "../../config/loader";
import { resolveMaxToolLoops } from "../../config/loop-cap";
import { formatComparison } from "../../eval/format";
import type { RunnerDeps } from "../../eval/runner";
import { loadScenarios } from "../../eval/scenario";
import type { EventSource } from "../../events/log";
import { composePrompt } from "../../improve/promote";
import { runImproveRound } from "../../improve/round";
import { selectSamples } from "../../insights/explain";
import { openEventSource } from "../../insights/reader";
import { analyze, collectTrajectories } from "../../insights/report";
import { loadMemories } from "../../memory/load";
import { buildProvider } from "../../providers/factory";
import { ProviderRegistry } from "../../providers/registry";
import { createSandbox } from "../../sandbox/factory";

export interface ImproveIo {
  write: (s: string) => void;
  writeErr: (s: string) => void;
  globalConfigPath?: string;
}

const EMPTY_SOURCE: EventSource = { listSessions: () => [], query: () => [] };

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function runImprove(
  argv: string[],
  projectDir: string,
  io: ImproveIo,
): Promise<number> {
  const idx = argv.indexOf("improve");
  const rest = idx >= 0 ? argv.slice(idx + 1) : argv;

  const prog = new Command();
  prog
    .name("cleetus improve")
    .description("Generate and evaluate instruction variants")
    .option("--candidates <n>", "number of LLM variants", "4")
    .option("--trials <n>", "eval trials per candidate", "3")
    .option("--scenario <name>", "restrict scenarios (repeatable)", collect, [])
    .option("--model <name>", "model for mutation (defaults to the configured default)")
    .option("--apply", "write the winner to .cleetus/instructions.md (with backup)")
    .option("--json", "emit the result as JSON")
    .allowExcessArguments()
    .exitOverride();
  try {
    prog.parse(rest, { from: "user" });
  } catch (e) {
    return (e as { exitCode?: number }).exitCode ?? 1;
  }
  const o = prog.opts<{
    candidates: string;
    trials: string;
    scenario: string[];
    model?: string;
    apply?: boolean;
    json?: boolean;
  }>();

  const GLOBAL_CONFIG = io.globalConfigPath ?? join(homedir(), ".config", "cleetus", "config.yaml");
  const config = await loadConfig({ globalPath: GLOBAL_CONFIG, projectDir });

  if (config.sandbox.backend !== "docker") {
    io.writeErr(
      "improve requires sandbox.backend: docker — eval runs must be sandboxed; refusing to run on host\n",
    );
    return 3;
  }
  if (!config.sandbox.image) {
    io.writeErr("improve requires an explicit sandbox.image (docker backend)\n");
    return 3;
  }

  let scenarios = loadScenarios(join(projectDir, "scenarios"));
  if (o.scenario.length > 0) scenarios = scenarios.filter((s) => o.scenario.includes(s.name));
  if (scenarios.length === 0) {
    io.write("no scenarios found\n");
    return 0;
  }

  const GLOBAL_DIR = dirname(GLOBAL_CONFIG);
  const globalContext = await readIfExists(join(GLOBAL_DIR, "instructions.md"));
  // The mutable unit is THIS project's .cleetus/instructions.md (read == --apply write target),
  // read directly (no ancestor walk) so a winning block is written back to the same file.
  const baseInstructions = await readIfExists(join(projectDir, ".cleetus", "instructions.md"));
  const memoriesContext = loadMemories({
    globalPath: join(GLOBAL_DIR, "memory.md"),
    projectPath: join(projectDir, ".cleetus", "memory.md"),
  });

  const providerName = config.defaultProvider ?? Object.keys(config.providers)[0];
  const model = o.model ?? config.defaultModel;
  const pcfg = providerName ? config.providers[providerName] : undefined;
  if (!pcfg || !model || !providerName) {
    io.writeErr(
      "improve needs a configured default provider + model (config.defaultProvider/defaultModel)\n",
    );
    return 1;
  }
  const providers = new ProviderRegistry();
  for (const [name, p] of Object.entries(config.providers)) {
    providers.register(name, buildProvider(p.type, p.baseUrl, p.apiKey));
  }

  const source = openEventSource(join(projectDir, ".cleetus", "sessions.db")) ?? EMPTY_SOURCE;
  const report = analyze(source, {});
  const samples = selectSamples(report, collectTrajectories(source, {}));
  if (report.trajectoryCount === 0) {
    io.writeErr("note: no session history yet — mutation will be less targeted\n");
  }

  const runnerDeps: RunnerDeps = {
    providers,
    sandboxConfig: config.sandbox,
    makeSandbox: createSandbox,
    baseline: {
      systemPrompt: composePrompt(globalContext, baseInstructions, memoriesContext),
      active: { provider: providerName, model },
      mode: resolveStartRouteMode(config.routing, undefined).mode,
      tiers: config.routing.tiers,
      smart: config.routing.smart,
      maxToolLoops: resolveMaxToolLoops(undefined, config.maxToolLoops).value,
    },
  };

  const countRaw = Math.trunc(Number(o.candidates));
  const count = Number.isFinite(countRaw) && countRaw >= 1 ? countRaw : 4;
  const trialsRaw = Math.trunc(Number(o.trials));
  const trials = Number.isFinite(trialsRaw) && trialsRaw >= 1 ? trialsRaw : 3;

  const result = await runImproveRound({
    provider: providers.get(providerName),
    model,
    runnerDeps,
    scenarios,
    baseInstructions,
    globalContext,
    memoriesContext,
    report,
    samples,
    count,
    trials,
    apply: o.apply ?? false,
    projectDir,
    now: Date.now(),
    log: (s) => io.writeErr(s),
  });

  if (o.json) {
    io.write(
      `${JSON.stringify(
        {
          winner: result.winner,
          applied: result.applied,
          backupPath: result.backupPath ?? null,
          diff: result.diff ?? null,
          note: result.note ?? null,
          scorecards: result.comparison.ranked.map((c) => ({
            candidate: c.candidate,
            passed: c.passed,
            scenariosRun: c.scenariosRun,
            passRate: c.passRate,
            totalToolFailures: c.totalToolFailures,
            totalLoops: c.totalLoops,
            totalTokens: c.totalTokens,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (result.note) {
    io.write(`${result.note}\n`);
    return 0;
  }
  io.write(`${formatComparison(result.comparison)}\n`);
  if (!result.winner) {
    io.write("no candidate beat the baseline; nothing to apply\n");
    return 0;
  }
  if (result.applied) {
    io.write(
      `applied ${result.winner.name} → .cleetus/instructions.md (${result.winner.reason})` +
        `${result.backupPath ? ` · backup: ${result.backupPath}` : ""}\n`,
    );
  } else {
    io.write(`\nwinner: ${result.winner.name} (${result.winner.reason})\n`);
    if (result.diff) io.write(`\n${result.diff}\n`);
    io.write("\nwrote candidate to candidates/; re-run with --apply to adopt\n");
  }
  return 0;
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}
