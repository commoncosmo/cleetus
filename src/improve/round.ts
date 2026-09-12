import type { Candidate } from "../eval/candidate";
import { BASELINE } from "../eval/candidate";
import { compare } from "../eval/compare";
import { type RunnerDeps, runCandidate } from "../eval/runner";
import type { Scenario } from "../eval/scenario";
import { scoreRun } from "../eval/score";
import type { Comparison, RunScore } from "../eval/types";
import type { InsightsReport } from "../insights/report";
import type { Trajectory } from "../insights/trajectory";
import type { Provider } from "../providers/types";
import { selectWinner } from "./gate";
import { proposeCandidates } from "./mutate";
import { type WinningVariant, applyWinner, composePrompt, proposeWinner } from "./promote";

export interface ImproveResult {
  comparison: Comparison;
  winner: { name: string; reason: string } | null;
  applied: boolean;
  backupPath?: string | null;
  diff?: string;
  note?: string;
}

export interface ImproveRoundDeps {
  provider: Provider; // mutation model provider
  model: string; // mutation model
  runnerDeps: RunnerDeps; // eval deps (baseline.systemPrompt must already be composePrompt(global, baseInstructions, memories))
  scenarios: Scenario[];
  baseInstructions: string;
  globalContext: string;
  memoriesContext: string;
  report: InsightsReport;
  samples: Trajectory[];
  count: number;
  trials: number;
  apply: boolean;
  projectDir: string;
  now: number;
  signal?: AbortSignal;
  log?: (s: string) => void;
}

export async function runImproveRound(deps: ImproveRoundDeps): Promise<ImproveResult> {
  const variants = await proposeCandidates({
    baseInstructions: deps.baseInstructions,
    globalContext: deps.globalContext,
    memoriesContext: deps.memoriesContext,
    report: deps.report,
    samples: deps.samples,
    provider: deps.provider,
    model: deps.model,
    count: deps.count,
    signal: deps.signal,
  });

  if (variants.length === 0) {
    return {
      comparison: { baseline: BASELINE.name, ranked: [] },
      winner: null,
      applied: false,
      note: "no usable candidates generated",
    };
  }

  const variantCandidates: Candidate[] = variants.map((v) => ({
    name: v.name,
    systemPrompt: composePrompt(deps.globalContext, v.instructions, deps.memoriesContext),
  }));
  const candidates: Candidate[] = [BASELINE, ...variantCandidates];

  const scores: RunScore[] = [];
  for (const candidate of candidates) {
    for (const scenario of deps.scenarios) {
      for (let t = 0; t < deps.trials; t++) {
        deps.log?.(`running ${candidate.name} × ${scenario.name} … `);
        try {
          const record = await runCandidate(candidate, scenario, deps.runnerDeps);
          scores.push(scoreRun(record));
          deps.log?.("done\n");
        } catch (e) {
          deps.log?.(`error [${(e as Error).message}]\n`);
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
  const gate = selectWinner(comparison);
  if (!gate.winner) {
    return { comparison, winner: null, applied: false };
  }

  const won = variants.find((v) => v.name === gate.winner!.candidate)!;
  const winning: WinningVariant = {
    name: won.name,
    instructions: won.instructions,
    systemPrompt: composePrompt(deps.globalContext, won.instructions, deps.memoriesContext),
  };
  const ctx = {
    projectDir: deps.projectDir,
    baseInstructions: deps.baseInstructions,
    now: deps.now,
  };

  if (deps.apply) {
    const { backupPath } = await applyWinner(winning, ctx);
    return {
      comparison,
      winner: { name: won.name, reason: gate.reason },
      applied: true,
      backupPath,
    };
  }
  const { diff } = await proposeWinner(winning, ctx);
  return { comparison, winner: { name: won.name, reason: gate.reason }, applied: false, diff };
}
