import type { Event } from "../events/types";
import type { InsightsReport } from "../insights/report";

export type AgentOutcome = "completed" | "timed_out" | "error" | "sandbox_unavailable";

export interface RunRecord {
  candidate: string;
  scenario: string;
  events: Event[];
  checkExitCode: number | null;
  agentOutcome: AgentOutcome;
  elapsedMs: number;
}

export interface RunScore {
  candidate: string;
  scenario: string;
  passed: boolean;
  metrics: InsightsReport;
  toolFailures: number;
  loops: number;
  tokens: number;
  elapsedMs: number;
}

export interface CandidateScorecard {
  candidate: string;
  scenariosRun: number;
  passed: number;
  passRate: number;
  totalToolFailures: number;
  totalLoops: number;
  totalTokens: number;
  totalElapsedMs: number;
  runs: RunScore[];
}

export interface Comparison {
  baseline: string;
  ranked: CandidateScorecard[];
}
