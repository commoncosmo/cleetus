import { resolve } from "node:path";
import { shellJoin } from "../git/quote";
import { plainPowerShellOutput } from "../sandbox/powershell-output";
import { powershellArgs } from "../sandbox/shell";
import {
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  SandboxUnavailableError,
} from "../sandbox/types";
import type { ClientRequestOptions } from "./transport";

type RequestFn = (
  method: string,
  params: unknown,
  options?: ClientRequestOptions,
) => Promise<unknown>;
const CLEANUP_MS = 2000;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Client terminals own containment and process-tree cleanup. Never fall back to local exec. */
export class AcpSandbox implements Sandbox {
  readonly shell: "powershell" | "bash";
  private disposed = false;
  private readonly active = new Set<AbortController>();
  private readonly pending = new Set<Promise<ExecResult>>();
  constructor(
    private readonly request: RequestFn,
    private readonly sessionId: string,
    _fallback: Sandbox,
    platform: NodeJS.Platform = process.platform,
    private readonly defaultCwd = process.cwd(),
    private readonly executable?: string,
  ) {
    this.shell = platform === "win32" ? "powershell" : "bash";
  }
  async shellExecutable(): Promise<string> {
    return this.executable ?? (this.shell === "powershell" ? "pwsh.exe" : "bash");
  }
  exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    return this.execArgv(
      this.shell === "powershell"
        ? [this.executable ?? "pwsh.exe", ...powershellArgs(command)]
        : [this.executable ?? "bash", "-lc", command],
      opts,
    );
  }
  execArgv(argv: string[], opts: ExecOptions): Promise<ExecResult> {
    if (!argv.length) return Promise.reject(new Error("execArgv requires an executable"));
    if (this.disposed)
      return Promise.reject(new SandboxUnavailableError("ACP terminal adapter is disposed"));
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
    this.active.add(controller);
    const pending = this.run(argv, { ...opts, signal: controller.signal });
    this.pending.add(pending);
    return pending.finally(() => {
      this.active.delete(controller);
      this.pending.delete(pending);
      opts.signal.removeEventListener("abort", abort);
    });
  }
  private async run(argv: string[], opts: ExecOptions): Promise<ExecResult> {
    const result: ExecResult = {
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      cancelled: false,
    };
    if (opts.signal.aborted) return { ...result, cancelled: true };
    const env = Object.entries(opts.env ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, value]) => ({ name, value }));
    let command = argv[0]!;
    let args = argv.slice(1);
    if (opts.stdin !== undefined) {
      const key = `CLEETUS_ACP_STDIN_${crypto.randomUUID().replaceAll("-", "")}`;
      if (this.shell === "powershell") {
        env.push({ name: key, value: Buffer.from(opts.stdin).toString("base64") });
        const script = `$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${key})); [Environment]::SetEnvironmentVariable('${key}',$null,'Process'); $info=[Diagnostics.ProcessStartInfo]::new(); $info.FileName=${literal(command)}; ${args.map((arg) => `$info.ArgumentList.Add(${literal(arg)});`).join(" ")} $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.StandardInputEncoding=[Text.UTF8Encoding]::new($false); $info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false); $info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false); $p=[Diagnostics.Process]::new(); $p.StartInfo=$info; $null=$p.Start(); $stdout=$p.StandardOutput.ReadToEndAsync(); $stderr=$p.StandardError.ReadToEndAsync(); $p.StandardInput.Write($data); $p.StandardInput.Close(); $p.WaitForExit(); [Console]::Out.Write($stdout.GetAwaiter().GetResult()); [Console]::Error.Write($stderr.GetAwaiter().GetResult()); exit $p.ExitCode`;
        command = this.executable ?? "pwsh.exe";
        args = powershellArgs(script);
      } else {
        if (opts.stdin.includes(String.fromCharCode(0)))
          throw new SandboxUnavailableError("ACP Bash stdin cannot contain NUL bytes");
        env.push({ name: key, value: opts.stdin });
        command = "bash";
        args = ["-c", `set -o pipefail; printf '%s' "$${key}" | ${shellJoin(argv)}`];
      }
    }
    let wake!: () => void;
    const stopped = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const abort = () => {
      result.cancelled = true;
      result.timedOut = false;
      wake();
    };
    opts.signal.addEventListener("abort", abort, { once: true });
    if (opts.signal.aborted) abort();
    const timer =
      opts.timeoutMs == null
        ? undefined
        : setTimeout(() => {
            if (!result.cancelled) result.timedOut = true;
            wake();
          }, opts.timeoutMs);
    const call = async (method: string, terminalId: string) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.request(
            method,
            { sessionId: this.sessionId, terminalId },
            { timeoutMs: CLEANUP_MS },
          ),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error(`ACP ${method} cleanup timed out`)),
              CLEANUP_MS,
            );
          }),
        ]);
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    };
    const waitAbort = new AbortController();
    let terminalId: string | undefined;
    try {
      const create = this.request(
        "terminal/create",
        {
          sessionId: this.sessionId,
          command,
          args,
          cwd: resolve(this.defaultCwd, opts.cwd ?? "."),
          env,
          outputByteLimit: 200000,
        },
        { timeoutMs: 30000 },
      ) as Promise<{ terminalId: string }>;
      const created = await Promise.race([create, stopped.then(() => null)]);
      if (!created) {
        void create
          .then(async (late) => {
            await call("terminal/kill", late.terminalId).catch(() => {});
            await call("terminal/release", late.terminalId).catch(() => {});
          })
          .catch(() => {});
        return result;
      }
      if (typeof created.terminalId !== "string" || !created.terminalId)
        throw new Error("ACP client returned an invalid terminalId");
      terminalId = created.terminalId;
      const wait = this.request(
        "terminal/wait_for_exit",
        { sessionId: this.sessionId, terminalId },
        {
          signal: waitAbort.signal,
          timeoutMs: opts.timeoutMs == null ? 86400000 : opts.timeoutMs + 10000,
        },
      );
      wait.catch(() => {});
      const winner = await Promise.race([
        wait.then((status) => ({ status })),
        stopped.then(() => null),
      ]);
      if (result.cancelled || result.timedOut)
        await call("terminal/kill", terminalId).catch(() => {
          result.stderr = "ACP client did not confirm terminal termination. ";
        });
      const out = (await call("terminal/output", terminalId)) as {
        output: string;
        truncated?: boolean;
        exitStatus?: { exitCode?: number | null };
      };
      result.stdout = this.shell === "powershell" ? plainPowerShellOutput(out.output) : out.output;
      const waited = winner?.status as
        | { exitCode?: number | null; exitStatus?: { exitCode?: number | null } }
        | undefined;
      result.exitCode =
        out.exitStatus?.exitCode ?? waited?.exitCode ?? waited?.exitStatus?.exitCode ?? null;
      if (out.truncated) result.stderr += "ACP client truncated earlier terminal output.";
      return result;
    } catch (error) {
      if (terminalId) await call("terminal/kill", terminalId).catch(() => {});
      if (result.cancelled || result.timedOut) {
        result.stderr += (error as Error).message;
        return result;
      }
      throw error;
    } finally {
      waitAbort.abort();
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener("abort", abort);
      if (terminalId)
        await call("terminal/release", terminalId).catch(() => {
          result.stderr += " ACP terminal release failed; client cleanup is required.";
        });
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    await Promise.allSettled(this.pending);
  }
  writeRoot(): null {
    return null;
  }
}
