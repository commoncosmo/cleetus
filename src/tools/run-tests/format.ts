export interface TestRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number;
  maxLines: number;
  summaryRegex?: RegExp;
}

/**
 * Shape a captured test run into "summary + failures, capped".
 * Pass → headline plus the runner's summary line (if matched), nothing else.
 * Fail/timeout → header plus the capped tail of combined output (where failures live).
 * Pure; never throws on ordinary string input.
 */
export function formatTestResult(r: TestRunResult): string {
  // Real runner output usually ends in a newline; trim it so split() doesn't
  // produce a ghost empty line that inflates the cap count.
  const combined = [r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd();

  if (r.exitCode === 0 && !r.timedOut) {
    const match = r.summaryRegex ? combined.match(r.summaryRegex) : null;
    return match ? `✓ tests passed\n${match[0]}` : "✓ tests passed";
  }

  const header = r.timedOut
    ? `✗ tests timed out after ${r.timeoutMs}ms`
    : `✗ tests failed (exit ${r.exitCode ?? "unknown"})`;

  if (combined.length === 0) return header;
  return `${header}\n${cappedTail(combined, r.maxLines)}`;
}

/** Last `maxLines` lines, prefixed with an omitted-count note when truncated. */
function cappedTail(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const omitted = lines.length - maxLines;
  return `…${omitted} earlier lines omitted\n${lines.slice(-maxLines).join("\n")}`;
}
