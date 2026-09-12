import type { SmokeRunConfig } from "../../config/smoke-run";
import type { Sandbox } from "../../sandbox/types";
import { SandboxUnavailableError } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import { formatSmokeResult } from "./format";

/** Resolve the requested window to a safe bounded value: default when omitted, clamped to
 *  [1, maxSeconds]. Pure. */
export function clampSeconds(requested: number | undefined, cfg: SmokeRunConfig): number {
  if (requested === undefined) return cfg.defaultSeconds;
  return Math.max(1, Math.min(requested, cfg.maxSeconds));
}

/** smoke_run owns timeout and process-tree teardown. Backgrounding the command makes the shell
 * exit early, produces a false clean result, and can leave an unverified child behind. */
export function backgroundsSmokeCommand(command: string): boolean {
  return /(?:^|[^&])&(?!(?:&|\d))/m.test(command);
}

interface SmokeRunArgs {
  command?: unknown;
  seconds?: unknown;
}

export class SmokeRunTool implements Tool {
  name = "smoke_run";
  // Runs arbitrary shell commands (e.g. `bun install`) — side-effectful, so plan mode blocks
  // it and it is permission-gated, like bash.
  mutates = true;
  description =
    "Run a command for a few seconds to check that it starts/builds/runs cleanly — use for " +
    "things that don't exit on their own (dev servers, GUI launches, watch processes) before " +
    "recommending them to the user. Reports whether the command exited cleanly, failed, or is " +
    "still running. For the project's test suite use run_tests instead.";
  parameters = {
    type: "object",
    properties: {
      command: { type: "string" },
      seconds: { type: "integer", minimum: 1 },
    },
    required: ["command"],
    additionalProperties: false,
  };

  constructor(
    private readonly sandbox: Sandbox,
    private readonly cfg: SmokeRunConfig,
  ) {}

  serialize(args: unknown): string {
    const a = (args ?? {}) as SmokeRunArgs;
    return typeof a.command === "string" ? a.command : "smoke_run(?)";
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = (args ?? {}) as SmokeRunArgs;
    const command = a.command as string; // `command` is required (validated before dispatch)
    const seconds = clampSeconds(typeof a.seconds === "number" ? a.seconds : undefined, this.cfg);
    if (backgroundsSmokeCommand(command)) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage:
          "smoke_run manages timeout and teardown; pass the foreground command without '&'",
      };
    }

    let result: Awaited<ReturnType<Sandbox["exec"]>>;
    try {
      result = await this.sandbox.exec(command, {
        cwd: ctx.projectDir,
        timeoutMs: seconds * 1000,
        signal: ctx.abortSignal,
      });
    } catch (e) {
      const message = e instanceof SandboxUnavailableError ? e.message : (e as Error).message;
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: message };
    }

    if (result.cancelled) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: "✗ smoke_run cancelled" };
    }

    return {
      ok: true,
      output: formatSmokeResult({
        command,
        seconds,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        maxLines: this.cfg.maxOutputLines,
        survivors: result.survivors,
      }),
    };
  }
}
