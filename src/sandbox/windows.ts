import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { userPaths } from "../config/user-paths";
import { secretDirPaths, secretFilePaths } from "../security/secret-paths";
import { CLEETUS_SANDBOX_ACTIVE_ENV } from "./host";
import { resolvePowerShell } from "./powershell";
import { normalizeWindowsResult } from "./powershell-output";
import { powershellArgs } from "./shell";
import { spawnCollect } from "./spawn";
import { type ExecOptions, type ExecResult, type Sandbox, SandboxUnavailableError } from "./types";

/** CommandLineToArgvW/CRT quoting, including trailing backslashes before a quote. */
export function windowsQuote(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

export function windowsExecutorPath(): string {
  return join(dirname(process.execPath), "native", "wxc-exec.exe");
}

export class WindowsSandbox implements Sandbox {
  readonly shell = "powershell" as const;
  private readonly active = new Set<AbortController>();
  private readonly pending = new Set<Promise<ExecResult>>();
  private disposed = false;
  private scratch?: string;
  constructor(
    private readonly projectDir: string,
    private readonly network: boolean,
    private readonly executor = windowsExecutorPath(),
    private readonly powershell = Bun.which("pwsh.exe"),
    private readonly home = homedir(),
  ) {}

  shellExecutable(): Promise<string | null> {
    return resolvePowerShell(this.powershell);
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    const powershell = await this.shellExecutable();
    if (!powershell)
      throw new SandboxUnavailableError(
        "install PowerShell 7.4 or later (pwsh.exe must be on PATH)",
      );
    return this.execArgv([powershell, ...powershellArgs(command)], opts);
  }

  /** Application-generated commands bypass shell parsing. */
  async execArgv(argv: string[], opts: ExecOptions): Promise<ExecResult> {
    if (this.disposed) throw new SandboxUnavailableError("Windows sandbox is disposed");
    if (!argv.length) throw new Error("execArgv requires an executable");
    if (!existsSync(this.executor))
      throw new SandboxUnavailableError(`missing MXC executor: ${this.executor}`);
    const project = realpathSync(this.projectDir);
    const cwd = realpathSync(resolve(project, opts.cwd ?? "."));
    const home = this.home;
    if (!this.scratch) {
      this.scratch = realpathSync(mkdtempSync(join(tmpdir(), "cleetus-exec-")));
      mkdirSync(join(this.scratch, "temp"));
      mkdirSync(join(this.scratch, "cache"));
    }
    const temporary = join(this.scratch, "temp");
    // Match existing host backends: broad reads, project/cache/temp writes, secrets denied.
    // Include each referenced drive root, not just C:, for tools on other volumes.
    const roots = new Set(
      [
        project,
        cwd,
        home,
        this.executor,
        ...Object.values(process.env)
          .filter((v): v is string => typeof v === "string")
          .flatMap((v) => v.split(";")),
      ]
        .filter(isAbsolute)
        .map((p) => parse(p).root),
    );
    const protectedPaths = opts.protectProjectMetadata
      ? [join(project, ".git"), join(project, ".cleetus")]
      : [];
    const paths = userPaths(this.home);
    const portablePaths =
      paths.mode === "portable"
        ? [dirname(process.execPath), paths.dataRoot, join(paths.installRoot, "cleetus.portable")]
        : [];
    const cachePaths = [
      ".npm",
      ".cache",
      ".bun",
      ".cargo",
      ".pnpm-store",
      ".yarn",
      ".m2",
      ".gradle",
    ].map((p) => join(home, p));
    const local = process.env.LOCALAPPDATA;
    if (local)
      for (const path of ["npm-cache", "pip/Cache", "pnpm/store", "go-build", "uv/cache"])
        cachePaths.push(join(local, path));
    const writable = [project, tmpdir(), this.scratch, ...cachePaths].filter(existsSync);
    const environment = {
      ...process.env,
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
      BUN_TMPDIR: temporary,
      BUN_INSTALL_CACHE_DIR: join(this.scratch, "cache"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(this.scratch, "cache"),
      CLEETUS_TEMP: temporary,
      ...opts.env,
      HOME: home,
      [CLEETUS_SANDBOX_ACTIVE_ENV]: "host",
    };
    const config = {
      version: "1.0.0",
      containerId: crypto.randomUUID().replaceAll("-", ""),
      containment: "processcontainer",
      lifecycle: { destroyOnExit: true, preservePolicy: false },
      ui: { disable: false, clipboard: "none", injection: false },
      processContainer: {
        capabilities: [],
        ui: {
          isolation: "container",
          desktopSystemControl: false,
          systemSettings: "none",
          ime: false,
        },
      },
      process: {
        commandLine: argv.map(windowsQuote).join(" "),
        cwd,
        timeout: 0,
        env: Object.entries(environment)
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
          .map(([k, v]) => `${k}=${v}`),
        inheritDefaultEnv: false,
      },
      filesystem: {
        readwritePaths: writable,
        // A development build may live inside the writable checkout. Never let
        // a workload replace the trusted launcher used by subsequent commands.
        readonlyPaths: [
          ...roots,
          dirname(this.executor),
          process.execPath,
          ...portablePaths.filter(existsSync),
          ...protectedPaths.filter(existsSync),
        ],
        deniedPaths: [...secretDirPaths(home), ...secretFilePaths(home)].filter(existsSync),
      },
      network: {
        egress: { default: this.network ? "allow" : "deny" },
        ingress: { default: "deny", hostLoopback: this.network ? "allow" : "deny" },
      },
    };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
    if (encoded.length + this.executor.length > 30000)
      throw new SandboxUnavailableError("MXC request exceeds Windows command-line limit");
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort();
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
    const pending = spawnCollect([this.executor, "--config-base64", encoded], {
      ...opts,
      cwd,
      signal: controller.signal,
    });
    this.pending.add(pending);
    try {
      return normalizeWindowsResult(await pending);
    } catch (error) {
      throw new SandboxUnavailableError(error instanceof Error ? error.message : String(error));
    } finally {
      this.active.delete(controller);
      this.pending.delete(pending);
      opts.signal.removeEventListener("abort", abort);
    }
  }

  async healthCheck(): Promise<string | null> {
    try {
      const probe = await spawnCollect([this.executor, "--probe"], {
        signal: new AbortController().signal,
        timeoutMs: 5000,
      });
      if (probe.exitCode !== 0 || probe.timedOut)
        return probe.stderr || "MXC capability probe failed";
      const data = JSON.parse(probe.stdout) as {
        tier?: string;
        probes?: { baseContainerSupportsDenyPaths?: boolean };
      };
      if (data.tier !== "base-container" || !data.probes?.baseContainerSupportsDenyPaths)
        return "MXC ProcessContainer with denied-path support is unavailable; update Windows";
      const result = await this.exec(
        "if ($PSVersionTable.PSVersion -lt [version]'7.4') { throw 'PowerShell 7.4 or later is required' }",
        {
          signal: new AbortController().signal,
          timeoutMs: 10000,
        },
      );
      return result.exitCode === 0 && !result.timedOut
        ? null
        : result.stderr || "MXC shell health check failed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    await Promise.allSettled(this.pending);
    const scratch = this.scratch;
    try {
      if (
        scratch &&
        existsSync(scratch) &&
        dirname(scratch) === realpathSync(tmpdir()) &&
        !lstatSync(scratch).isSymbolicLink() &&
        realpathSync(scratch) === scratch
      ) {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    } catch {
      console.error(`[cleetus] Windows scratch cleanup deferred: ${scratch}`);
    }
  }
  writeRoot(): string {
    return this.projectDir;
  }
}
