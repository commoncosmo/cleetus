/** Outcome of a single build run. `errorTail` is "" when ok. */
export interface BuildAttempt {
  ok: boolean;
  errorTail: string;
}

/** Result of the bounded build gate. `fixRounds` = corrective worker passes performed:
 *  0 (passed) … maxAttempts (failing). `finalErrorTail` is present only when failing. */
export interface BuildGateResult {
  outcome: "passed" | "fixed" | "failing";
  fixRounds: number;
  finalErrorTail?: string;
}

/**
 * Build, and on failure run up to `maxAttempts` corrective rounds (fix → rebuild). Returns as
 * soon as a build succeeds. Pure orchestration over injected effects — no I/O of its own.
 * Aborts short-circuit to a `failing` result carrying the latest tail.
 */
export async function runBuildGate(args: {
  runBuild: (signal: AbortSignal) => Promise<BuildAttempt>;
  fix: (errorTail: string, signal: AbortSignal) => Promise<void>;
  maxAttempts: number;
  signal: AbortSignal;
}): Promise<BuildGateResult> {
  const { runBuild, fix, maxAttempts, signal } = args;
  let attempt = await runBuild(signal);
  if (attempt.ok) return { outcome: "passed", fixRounds: 0 };

  for (let round = 1; round <= maxAttempts; round++) {
    if (signal.aborted)
      return { outcome: "failing", fixRounds: round - 1, finalErrorTail: attempt.errorTail };
    await fix(attempt.errorTail, signal);
    if (signal.aborted)
      return { outcome: "failing", fixRounds: round, finalErrorTail: attempt.errorTail };
    attempt = await runBuild(signal);
    if (attempt.ok) return { outcome: "fixed", fixRounds: round };
  }
  // Loop ran to exhaustion (or maxAttempts === 0): we performed exactly maxAttempts fix rounds.
  return { outcome: "failing", fixRounds: maxAttempts, finalErrorTail: attempt.errorTail };
}
