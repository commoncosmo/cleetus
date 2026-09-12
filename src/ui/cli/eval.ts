import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { loadInstructions } from "../../agent/instructions";
import { resolveStartRouteMode } from "../../agent/route-modes";
import { loadConfig } from "../../config/loader";
import { resolveMaxToolLoops } from "../../config/loop-cap";
import { BASELINE, type Candidate, loadCandidates } from "../../eval/candidate";
import { compare } from "../../eval/compare";
import { formatComparison, toJson } from "../../eval/format";
import { type RunnerDeps, runCandidate } from "../../eval/runner";
import { loadScenarios } from "../../eval/scenario";
import { scoreRun } from "../../eval/score";
import type { RunScore } from "../../eval/types";
import { loadMemories } from "../../memory/load";
import { buildProvider } from "../../providers/factory";
import { ProviderRegistry } from "../../providers/registry";
import { createSandbox } from "../../sandbox/factory";

export interface EvalIo {
  write: (s: string) => void;
  writeErr: (s: string) => void;
  /** Override for testing: path to a global config.yaml (defaults to ~/.config/cleetus/config.yaml). */
  globalConfigPath?: string;
}

export async function runEval(argv: string[], projectDir: string, io: EvalIo): Promise<number> {
  const idx = argv.indexOf("eval");
  const rest = idx >= 0 ? argv.slice(idx + 1) : argv;

  const prog = new Command();
  prog
    .name("cleetus eval")
    .description("Evaluate agent candidates against scenarios")
    .option("--scenario <name>", "run only this scenario (repeatable)", collect, [])
    .option("--candidate <name>", "run only this candidate (repeatable)", collect, [])
    .option("--trials <n>", "repeat each run N times", "1")
    .option("--json", "emit the Comparison as JSON")
    .option("--scenarios-dir <dir>", "scenarios directory", "scenarios")
    .option("--candidates-dir <dir>", "candidates directory", "candidates")
    .allowExcessArguments()
    .exitOverride();
  try {
    prog.parse(rest, { from: "user" });
  } catch (e) {
    return (e as { exitCode?: number }).exitCode ?? 1;
  }
  const o = prog.opts<{
    scenario: string[];
    candidate: string[];
    trials: string;
    json?: boolean;
    scenariosDir: string;
    candidatesDir: string;
  }>();

  const GLOBAL_CONFIG = io.globalConfigPath ?? join(homedir(), ".config", "cleetus", "config.yaml");
  const config = await loadConfig({ globalPath: GLOBAL_CONFIG, projectDir });

  // Safety gate: unattended auto-allowed runs must be sandboxed.
  if (config.sandbox.backend !== "docker") {
    io.writeErr(
      "eval requires sandbox.backend: docker — unattended auto-allowed runs must be sandboxed; refusing to run on host\n",
    );
    return 3;
  }

  // Unattended runs must name their image explicitly (no silent default).
  if (!config.sandbox.image) {
    io.writeErr("eval requires an explicit sandbox.image (docker backend)\n");
    return 3;
  }

  // Scenario discovery (cheap fs) before building providers/baseline.
  let scenarios = loadScenarios(join(projectDir, o.scenariosDir));
  if (o.scenario.length > 0) scenarios = scenarios.filter((s) => o.scenario.includes(s.name));
  if (scenarios.length === 0) {
    io.write("no scenarios found\n");
    return 0;
  }

  // Resolve the baseline agent (mirrors cleetus.ts construction).
  const GLOBAL_DIR = dirname(GLOBAL_CONFIG);
  const instructions = await loadInstructions({
    globalPath: join(GLOBAL_DIR, "instructions.md"),
    startDir: projectDir,
  });
  const memories = loadMemories({
    globalPath: join(GLOBAL_DIR, "memory.md"),
    projectPath: join(projectDir, ".cleetus", "memory.md"),
  });
  const systemPrompt = [instructions, memories].filter(Boolean).join("\n\n");

  const providerName = config.defaultProvider ?? Object.keys(config.providers)[0];
  const model = config.defaultModel;
  const pcfg = providerName ? config.providers[providerName] : undefined;
  if (!pcfg || !model || !providerName) {
    io.writeErr(
      "eval needs a configured default provider + model (config.defaultProvider/defaultModel)\n",
    );
    return 1;
  }
  const providers = new ProviderRegistry();
  for (const [name, p] of Object.entries(config.providers)) {
    providers.register(name, buildProvider(p.type, p.baseUrl, p.apiKey));
  }

  const deps: RunnerDeps = {
    providers,
    sandboxConfig: config.sandbox,
    makeSandbox: createSandbox,
    baseline: {
      systemPrompt,
      active: { provider: providerName, model },
      mode: resolveStartRouteMode(config.routing, undefined).mode,
      tiers: config.routing.tiers,
      smart: config.routing.smart,
      maxToolLoops: resolveMaxToolLoops(undefined, config.maxToolLoops).value,
    },
  };

  let candidates: Candidate[] = [BASELINE, ...loadCandidates(join(projectDir, o.candidatesDir))];
  if (o.candidate.length > 0) candidates = candidates.filter((c) => o.candidate.includes(c.name));

  const trialsRaw = Math.trunc(Number(o.trials));
  const trials = Number.isFinite(trialsRaw) && trialsRaw >= 1 ? trialsRaw : 1;
  const scores: RunScore[] = [];
  for (const candidate of candidates) {
    for (const scenario of scenarios) {
      for (let t = 0; t < trials; t++) {
        io.writeErr(
          `running ${candidate.name} × ${scenario.name}${trials > 1 ? ` (trial ${t + 1}/${trials})` : ""} … `,
        );
        try {
          const record = await runCandidate(candidate, scenario, deps);
          const score = scoreRun(record);
          scores.push(score);
          io.writeErr(`${score.passed ? "pass" : "fail"} [${record.agentOutcome}]\n`);
        } catch (e) {
          io.writeErr(`error [${(e as Error).message}]\n`);
          scores.push(
            scoreRun({
              candidate: candidate.name,
              scenario: scenario.name,
              events: [],
              checkExitCode: null,
              agentOutcome: "error",
              elapsedMs: 0,
            }),
          );
        }
      }
    }
  }

  const comparison = compare(scores);
  io.write(o.json ? `${toJson(comparison)}\n` : `${formatComparison(comparison)}\n`);
  return 0;
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}
