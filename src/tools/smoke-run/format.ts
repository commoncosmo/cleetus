import { survivorWarning } from "../../sandbox/survivors";
import { detectHangSignal } from "./hang-signals";

export interface SmokeRunResult {
  command: string;
  /** The window (seconds) the command was given. */
  seconds: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  maxLines: number;
  /** PIDs that survived teardown (from ExecResult.survivors); appended as a warning. */
  survivors?: number[];
}

/**
 * Shape a bounded command run into a verdict + captured output. A still-running process
 * (timed out) is reported informatively, NOT as a failure — that is the whole point of the
 * probe. Pure; never throws on ordinary string input.
 */
export function formatSmokeResult(r: SmokeRunResult): string {
  const combined = [r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd();

  let verdict: string;
  if (r.timedOut) {
    const hang = detectHangSignal(combined);
    if (hang) {
      verdict = `⚠ likely stuck after ${r.seconds}s — did not exit, and the output signals a hang rather than a healthy long-running process: ${hang.hint}`;
    } else {
      verdict = `⏱ still running after ${r.seconds}s — did not exit on its own. For a server, watcher, or GUI this usually means it started; READ the output below for hang or error signals (e.g. "waiting for…", "connection refused", a stack trace) before trusting it.`;
    }
  } else if (r.exitCode === 0) {
    verdict = "✓ exited cleanly (code 0)";
  } else {
    verdict = `✗ exited with code ${r.exitCode ?? "unknown"} — the command failed; output below`;
  }

  const head = `${verdict}\n$ ${r.command}`;
  const body = combined.length === 0 ? head : `${head}\n${cappedHeadTail(combined, r.maxLines)}`;
  const warning = survivorWarning(r.survivors);
  return warning ? `${body}\n${warning}` : body;
}

/** Keep the first and last lines, dropping the middle with an omitted-count marker.
 *  Head is biased larger (startup banners matter); tail catches late crashes. */
function cappedHeadTail(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const head = Math.ceil(maxLines / 2);
  const tail = maxLines - head;
  const omitted = lines.length - maxLines;
  return `${lines.slice(0, head).join("\n")}\n…${omitted} lines omitted…\n${lines
    .slice(lines.length - tail)
    .join("\n")}`;
}
