import { join } from "node:path";
import type { BuildGateConfig } from "../../config/build-gate";
import type { Sandbox } from "../../sandbox/types";
import type { VerificationResult } from "../types";

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

async function exists(projectDir: string, rel: string): Promise<boolean> {
  return await Bun.file(join(projectDir, rel)).exists();
}

async function packageManager(projectDir: string): Promise<PackageManager> {
  if ((await exists(projectDir, "bun.lock")) || (await exists(projectDir, "bun.lockb"))) {
    return "bun";
  }
  if (await exists(projectDir, "pnpm-lock.yaml")) return "pnpm";
  if (await exists(projectDir, "yarn.lock")) return "yarn";
  return "npm";
}

/** Detect deterministic JS/TS quality scripts that should gate final semantic acceptance. */
export async function detectQualityCommands(projectDir: string): Promise<string[]> {
  try {
    const raw = await Bun.file(join(projectDir, "package.json")).text();
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const pm = await packageManager(projectDir);
    return ["lint", "typecheck"]
      .filter((name) => typeof pkg.scripts?.[name] === "string")
      .map((name) => `${pm} run ${name}`);
  } catch {
    return [];
  }
}

function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}

export type VerifyQuality = (signal: AbortSignal) => Promise<VerificationResult[]>;

/**
 * Run configured lint/typecheck scripts independently of the semantic-verifier model. The model
 * may add richer evidence, but it cannot make a failing deterministic gate disappear by omitting
 * that command from a retry report.
 */
export function makeVerifyQuality(args: {
  projectDir: string;
  sandbox: Pick<Sandbox, "exec">;
  config: BuildGateConfig;
}): VerifyQuality | undefined {
  const { projectDir, sandbox, config } = args;
  if (!config.enabled) return undefined;

  return async (signal) => {
    const commands = await detectQualityCommands(projectDir);
    const results: VerificationResult[] = [];
    for (const command of commands) {
      if (signal.aborted) break;
      try {
        const result = await sandbox.exec(command, {
          cwd: projectDir,
          timeoutMs: config.timeoutMs,
          signal,
        });
        const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled;
        const combined = [result.stderr, result.stdout].filter(Boolean).join("\n").trimEnd();
        const timeout = result.timedOut
          ? `\n(command timed out after ${Math.round(config.timeoutMs / 1000)}s)`
          : "";
        results.push({
          key: `bash:${command}`,
          command,
          ok,
          detail: ok
            ? combined || "command exited 0"
            : `${lastLines(combined, config.maxOutputLines)}${timeout}`,
          scope: "full",
        });
      } catch (error) {
        results.push({
          key: `bash:${command}`,
          command,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          scope: "full",
        });
      }
    }
    return results;
  };
}
