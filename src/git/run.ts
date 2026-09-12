import type { Sandbox } from "../sandbox/types";
import { shellJoin } from "./quote";

export interface GitRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

/** Minimal context a git/gh invocation needs. `ToolContext` is structurally assignable. */
export interface GitRunContext {
  projectDir: string;
  abortSignal: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;

async function runBin(
  bin: string,
  sandbox: Sandbox,
  argv: string[],
  ctx: GitRunContext,
  opts?: { timeoutMs?: number },
): Promise<GitRunResult> {
  const r = await sandbox.exec(shellJoin([bin, ...argv]), {
    cwd: ctx.projectDir,
    signal: ctx.abortSignal,
    timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut,
    cancelled: r.cancelled,
  };
}

export function runGit(
  sandbox: Sandbox,
  argv: string[],
  ctx: GitRunContext,
  opts?: { timeoutMs?: number },
): Promise<GitRunResult> {
  return runBin("git", sandbox, argv, ctx, opts);
}

export function runGh(
  sandbox: Sandbox,
  argv: string[],
  ctx: GitRunContext,
  opts?: { timeoutMs?: number },
): Promise<GitRunResult> {
  return runBin("gh", sandbox, argv, ctx, opts);
}
