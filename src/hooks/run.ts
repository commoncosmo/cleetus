import type { Sandbox } from "../sandbox/types";
import type { HookEntry, HookRun } from "./types";

const DEFAULT_TIMEOUT_MS = 30000;

/** Run one hook command via the sandbox with the JSON payload on stdin. Never throws —
 *  a spawn failure / sandbox-unavailable becomes `errored: true` (the caller fails closed). */
export async function runHook(
  entry: HookEntry,
  payloadJson: string,
  sandbox: Sandbox,
  signal: AbortSignal,
): Promise<HookRun> {
  try {
    const r = await sandbox.exec(entry.command, {
      timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal,
      stdin: payloadJson,
    });
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      errored: false,
    };
  } catch (e) {
    return {
      exitCode: null,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      timedOut: false,
      errored: true,
    };
  }
}
