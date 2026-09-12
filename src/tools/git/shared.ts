import type { GitRunResult } from "../../git/run";
import { SandboxUnavailableError } from "../../sandbox/types";
import type { ToolResult } from "../types";

const MAX_OUTPUT_BYTES = 200_000;
// Head/tail split mirrors the bash tool (WS2.2): for git/gh the tail carries the signal —
// the error after a long diff, the final summary of a log — so it gets the larger share.
const HEAD_BYTES = Math.floor(MAX_OUTPUT_BYTES * 0.25);
const TAIL_BYTES = MAX_OUTPUT_BYTES - HEAD_BYTES;

export function capOutput(s: string): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= MAX_OUTPUT_BYTES) return s;
  const elided = buf.byteLength - HEAD_BYTES - TAIL_BYTES;
  const head = buf.subarray(0, HEAD_BYTES).toString("utf8");
  const tail = buf.subarray(buf.byteLength - TAIL_BYTES).toString("utf8");
  return `${head}\n[… ${elided} bytes elided …]\n${tail}`;
}

export function toolFail(errorMessage: string): ToolResult {
  return { ok: false, errorCode: "TOOL_FAILED", errorMessage };
}

/** Map a finished git/gh run to a failure ToolResult, or null when it succeeded (exit 0). */
export function runFailure(op: string, r: GitRunResult): ToolResult | null {
  if (r.cancelled) return toolFail(`${op} cancelled`);
  if (r.timedOut) return toolFail(`${op} timed out`);
  if (r.exitCode !== 0) {
    const msg =
      r.stderr.trim() || r.stdout.trim() || `${op} failed (exit ${r.exitCode ?? "unknown"})`;
    return toolFail(capOutput(msg));
  }
  return null;
}

/** Map a thrown sandbox error to a failure ToolResult. */
export function sandboxFailure(e: unknown): ToolResult {
  const message = e instanceof SandboxUnavailableError ? e.message : (e as Error).message;
  return toolFail(message);
}
