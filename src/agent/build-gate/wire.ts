import type { BuildGateConfig } from "../../config/build-gate";
import type { Sandbox } from "../../sandbox/types";
import { detectBuildCommand } from "./detect";
import { type BuildAttempt, type BuildGateResult, runBuildGate } from "./gate";

export type VerifyBuild = (
  fix: (errorTail: string, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
) => Promise<BuildGateResult | null>;

/** Keep the last `n` lines of `text` (the tail catches the final, usually most relevant errors). */
function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(lines.length - n).join("\n");
}

/**
 * Build the orchestrator's `verifyBuild` dep. Returns `undefined` when the gate is disabled (the
 * orchestrator then skips it). Otherwise returns a closure that detects the build command LAZILY
 * (the project is created during the run), runs it in the sandbox, and drives the bounded gate.
 * A closure returning `null` means no build command was found at call time → skip, no notice.
 */
export function makeVerifyBuild(args: {
  projectDir: string;
  sandbox: Pick<Sandbox, "exec">;
  config: BuildGateConfig;
}): VerifyBuild | undefined {
  const { projectDir, sandbox, config } = args;
  if (!config.enabled) return undefined;

  return async (fix, signal) => {
    if (signal.aborted) return null;
    const cmd = await detectBuildCommand(projectDir);
    if (!cmd) return null;

    const command = cmd.argv.join(" ");
    const runBuild = async (sig: AbortSignal): Promise<BuildAttempt> => {
      try {
        const r = await sandbox.exec(command, {
          cwd: projectDir,
          timeoutMs: config.timeoutMs,
          signal: sig,
        });
        const ok = r.exitCode === 0 && !r.timedOut && !r.cancelled;
        if (ok) return { ok: true, errorTail: "" };
        const combined = [r.stderr, r.stdout].filter(Boolean).join("\n").trimEnd();
        const note = r.timedOut
          ? `\n(build timed out after ${Math.round(config.timeoutMs / 1000)}s)`
          : "";
        return { ok: false, errorTail: lastLines(combined, config.maxOutputLines) + note };
      } catch (e) {
        // SandboxUnavailableError (or any infra error) → surface as a failing build, not a crash.
        return { ok: false, errorTail: e instanceof Error ? e.message : String(e) };
      }
    };

    return runBuildGate({ runBuild, fix, maxAttempts: config.maxAttempts, signal });
  };
}
