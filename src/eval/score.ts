import type { EventSource } from "../events/log";
import { analyze } from "../insights/report";
import type { RunRecord, RunScore } from "./types";

/** Score a single run: deterministic check pass/fail + Phase 5A metrics. Pure. */
export function scoreRun(record: RunRecord): RunScore {
  const source: EventSource = {
    listSessions: () => [...new Set(record.events.map((e) => e.sessionId))],
    query: (id) => record.events.filter((e) => e.sessionId === id),
  };
  const metrics = analyze(source, {});
  const passed = record.agentOutcome === "completed" && record.checkExitCode === 0;
  const toolFailures = metrics.toolReliability.tools.reduce((n, t) => n + t.failures, 0);
  // maxLoops counts only complete trajectories (5A excludes incomplete turns), so a
  // timed_out/incomplete run yields loops=0 even if partial tool loops ran. Such runs
  // are non-passing anyway, so this does not affect ranking among passers.
  const loops = metrics.turnEfficiency.maxLoops;
  // totalTokens is null only when no model call reported usage (not a zero-token guard).
  const tokens = metrics.routingCost.totalTokens
    ? metrics.routingCost.totalTokens.input + metrics.routingCost.totalTokens.output
    : 0;
  return {
    candidate: record.candidate,
    scenario: record.scenario,
    passed,
    metrics,
    toolFailures,
    loops,
    tokens,
    elapsedMs: record.elapsedMs,
  };
}
