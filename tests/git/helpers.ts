import type { ExecOptions, ExecResult, Sandbox } from "../../src/sandbox/types";

export interface Call {
  command: string;
  opts: ExecOptions;
}

const DEFAULT: ExecResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  cancelled: false,
};

/** Sandbox that returns one canned result for every exec, recording calls. */
export function recordingSandbox(result: Partial<ExecResult> = {}): {
  sandbox: Sandbox;
  calls: Call[];
} {
  const calls: Call[] = [];
  const sandbox: Sandbox = {
    async exec(command, opts) {
      calls.push({ command, opts });
      return { ...DEFAULT, ...result };
    },
    async dispose() {},
    writeRoot: () => null,
  };
  return { sandbox, calls };
}

/**
 * Sandbox that picks a result by matching the command against route substrings
 * (first match wins; order routes specific-first). Unmatched commands return a
 * clean exit-0 default.
 */
export function scriptedSandbox(routes: { match: string; result: Partial<ExecResult> }[]): {
  sandbox: Sandbox;
  calls: Call[];
} {
  const calls: Call[] = [];
  const sandbox: Sandbox = {
    async exec(command, opts) {
      calls.push({ command, opts });
      const route = routes.find((r) => command.includes(r.match));
      return { ...DEFAULT, ...(route?.result ?? {}) };
    },
    async dispose() {},
    writeRoot: () => null,
  };
  return { sandbox, calls };
}

/** Sandbox whose exec always throws (exercises SandboxUnavailableError paths). */
export function throwingSandbox(err: Error): Sandbox {
  return {
    async exec() {
      throw err;
    },
    async dispose() {},
    writeRoot: () => null,
  };
}
