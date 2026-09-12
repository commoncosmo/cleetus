import type { ExecOptions, ExecResult, Sandbox } from "../sandbox/types";

type RequestFn = (method: string, params: unknown) => Promise<unknown>;

/** A Sandbox that runs commands through the ACP client's terminal instead of cleetus's own
 *  sandbox. Installed only when the client advertised `terminal`. In this mode the editor is the
 *  trust boundary — cleetus's Seatbelt isolation is intentionally bypassed. `fallback` exists only
 *  to satisfy `dispose()`; it is never exec'd here. */
export class AcpSandbox implements Sandbox {
  constructor(
    private readonly request: RequestFn,
    private readonly sessionId: string,
    private readonly fallback: Sandbox,
  ) {}

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    // Deliberate: a terminal/create rejection throws out of exec with no local sandbox fallback.
    // In client-terminal mode the editor is the trust boundary; falling back to cleetus's own
    // sandbox would silently bypass it.
    const created = (await this.request("terminal/create", {
      sessionId: this.sessionId,
      command: "bash",
      args: ["-lc", command],
      cwd: opts.cwd,
    })) as { terminalId: string };
    const terminalId = created.terminalId;

    let cancelled = false;
    const onAbort = async () => {
      cancelled = true;
      await this.request("terminal/kill", { sessionId: this.sessionId, terminalId }).catch(
        () => {},
      );
    };
    if (opts.signal.aborted) await onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    let resolveAbortRace!: (v: "aborted") => void;
    const onAbortRace = () => resolveAbortRace("aborted");

    try {
      const waitExit = this.request("terminal/wait_for_exit", {
        sessionId: this.sessionId,
        terminalId,
      });
      // Prevent a late transport rejection from surfacing as an unhandled rejection when the
      // abort race wins and waitExit is never awaited on that path.
      waitExit.catch(() => {});
      const abortRace = new Promise<"aborted">((resolve) => {
        resolveAbortRace = resolve;
        if (opts.signal.aborted) resolve("aborted");
        else opts.signal.addEventListener("abort", onAbortRace, { once: true });
      });
      const winner = await Promise.race([waitExit.then(() => "exited" as const), abortRace]);
      const out = (await this.request("terminal/output", {
        sessionId: this.sessionId,
        terminalId,
      })) as {
        output: string;
        exitStatus: { exitCode: number | null } | null;
      };
      const exitCode = out.exitStatus?.exitCode ?? null;
      return {
        stdout: out.output,
        stderr: "",
        exitCode,
        timedOut: false,
        cancelled: cancelled || winner === "aborted",
      };
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      opts.signal.removeEventListener("abort", onAbortRace);
      await this.request("terminal/release", { sessionId: this.sessionId, terminalId }).catch(
        () => {},
      );
    }
  }

  dispose(): Promise<void> {
    return this.fallback.dispose();
  }

  writeRoot(): string | null {
    return null;
  }
}
