import { resolve } from "node:path";
import { scanProject } from "../agent/bootstrap-location";
import { consistentPackageCommand, projectPackageManager } from "../lib/package-manager";
import { dirEscapesProject } from "../permission/path-guard";
import { looksLikeExecutionDenial, looksLikeWriteDenial } from "../sandbox/boundary";
import { survivorWarning } from "../sandbox/survivors";
import { type Sandbox, SandboxUnavailableError } from "../sandbox/types";
import { bsdHint } from "./bsd-hint";
import {
  destructiveCommandBlockMessage,
  destructiveCommandDecision,
  nestedGitInitGrounding,
} from "./destructive-command";
import { goToolchainSandboxHint } from "./go-sandbox-hint";
import { commandInvokesForeignPackageManager, packageManagerDecision } from "./package-manager";
import { powershellHint } from "./powershell-hint";
import type { Tool, ToolContext, ToolResult } from "./types";

/** Prefer the command's own project selection, then the containing project's selection. */
async function isBunProject(projectDir: string, cwd: string | undefined): Promise<boolean> {
  const dirs = cwd && cwd !== projectDir ? [resolve(projectDir, cwd), projectDir] : [projectDir];
  for (const dir of dirs) {
    const selected = await projectPackageManager(dir);
    if (selected) return selected === "bun";
  }
  return false;
}

interface Args {
  command: string;
  timeoutMs?: number;
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 200_000;
// Tail-weighted split: compilers/test runners put the failure summary at the END of
// output, so the tail is what the model needs to recover; the head keeps early context
// (e.g. which test file started failing).
const HEAD_BYTES = Math.floor(MAX_OUTPUT_BYTES * 0.25);
const TAIL_BYTES = MAX_OUTPUT_BYTES - HEAD_BYTES;

function truncate(s: string): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= MAX_OUTPUT_BYTES) return s;
  const head = buf.subarray(0, HEAD_BYTES).toString("utf8");
  const tail = buf.subarray(buf.byteLength - TAIL_BYTES).toString("utf8");
  const elided = buf.byteLength - HEAD_BYTES - TAIL_BYTES;
  return `${head}\n[… ${elided} bytes elided …]\n${tail}`;
}

function boundaryAdvisory(writeRoot: string): string {
  return `A write was blocked by the project sandbox. Writes are confined to ${writeRoot}; use a path inside it.`;
}

function cwdOutsideMessage(writeRoot: string): string {
  return `bash cwd is outside the project sandbox; commands must run within ${writeRoot}.`;
}

export class BashTool implements Tool {
  name = "bash";
  mutates = true;
  description =
    "Run a shell command via `bash -c`. Combined stdout/stderr is returned. Use `run_tests` " +
    "instead for project test suites; it preserves failures while returning much less output.";
  parameters = {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutMs: {
        type: "integer",
        minimum: 1000,
        default: DEFAULT_TIMEOUT_MS,
        description:
          "Timeout in milliseconds, minimum 1000. For 30 seconds use 30000; for 2 minutes use 120000. Omit to use the 120000ms default. Never pass seconds such as 30 or 60.",
      },
      cwd: { type: "string" },
    },
    required: ["command"],
  };

  /** `enforcePackageManager` (default true) gates the Bun-project foreign-manager guard; set false
   *  via config (packageManager.enforceBun) to allow a deliberate npx/npm command. */
  constructor(
    private readonly sandbox: Sandbox,
    private readonly options: { enforcePackageManager?: boolean } = {},
  ) {
    if (sandbox.shell === "powershell") {
      this.description =
        "Run a native PowerShell 7 command in the Windows sandbox. Use PowerShell syntax, not Bash. Native command failures and PowerShell errors fail the tool. Use run_tests for project test suites.";
    }
  }

  serialize(args: unknown): string {
    return (args as Args).command;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const original = args as Args;
    if (
      original.timeoutMs !== undefined &&
      (!Number.isSafeInteger(original.timeoutMs) || original.timeoutMs < 1000)
    )
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage:
          "timeoutMs must be an integer of at least 1000 milliseconds. For 30 seconds use 30000, for 60 seconds use 60000, or omit timeoutMs for the 120000ms default. No command was launched; seconds are not converted automatically.",
      };
    const selected = await projectPackageManager(
      original.cwd ? resolve(ctx.projectDir, original.cwd) : ctx.projectDir,
    );
    const a = {
      ...original,
      command:
        this.options.enforcePackageManager === false
          ? original.command
          : consistentPackageCommand(original.command, selected),
    };
    const timeout = a.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const writeRoot = this.sandbox.writeRoot();
    if (writeRoot != null && a.cwd != null && (await dirEscapesProject(a.cwd, writeRoot))) {
      return { ok: false, errorCode: "OUT_OF_TREE", errorMessage: cwdOutsideMessage(writeRoot) };
    }
    const nestedInit = nestedGitInitGrounding({
      command: a.command,
      cwd: a.cwd,
      projectDir: ctx.projectDir,
    });
    if (nestedInit) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: nestedInit };
    }
    const mayScaffold = /\b(?:bunx\s+create-|bun\s+create\b|(?:npm|pnpm|yarn)\s+create\b)/i.test(
      a.command,
    );
    const projectAlreadyExists = mayScaffold
      ? (await scanProject(ctx.projectDir)).at !== "none"
      : false;
    const destructive = destructiveCommandDecision({
      command: a.command,
      projectDir: ctx.projectDir,
      projectAlreadyExists,
      shell: this.sandbox.shell,
    });
    if (destructive.blocked) {
      return {
        ok: false,
        errorCode: "PERMISSION_DENIED",
        errorMessage: destructiveCommandBlockMessage(destructive.reason ?? "destructive command"),
      };
    }
    // Keep the toolchain consistent: in a Bun project, block npx/npm/yarn/pnpm (which would write a
    // competing lockfile and violate a bun-only setup) with the Bun equivalent. Probe the filesystem
    // only when the command actually invokes a foreign manager, so ordinary commands pay nothing.
    // Disabled by config (packageManager.enforceBun=false) as a deliberate-one-off escape hatch.
    if (
      this.options.enforcePackageManager !== false &&
      commandInvokesForeignPackageManager(a.command)
    ) {
      const pm = packageManagerDecision({
        command: a.command,
        bunProject: await isBunProject(ctx.projectDir, a.cwd),
      });
      if (pm.blocked) {
        return { ok: false, errorCode: "PERMISSION_DENIED", errorMessage: pm.message };
      }
    }
    let result: Awaited<ReturnType<Sandbox["exec"]>>;
    try {
      // Models commonly trim noisy verification output with `| tail` / `| head`. Bash normally
      // reports only the final pipeline process, which can turn a failed test/lint command into a
      // successful tool call. Make every bash-tool pipeline preserve its first real failure.
      result = await this.sandbox.exec(
        this.sandbox.shell === "powershell" ? a.command : `set -o pipefail\n${a.command}`,
        {
          cwd: a.cwd,
          timeoutMs: timeout,
          signal: ctx.abortSignal,
          protectProjectMetadata: true,
        },
      );
    } catch (e) {
      const message = e instanceof SandboxUnavailableError ? e.message : (e as Error).message;
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: message };
    }
    const combined = truncate(
      [
        a.command !== original.command
          ? `Using the project's ${selected} package manager: ${a.command}`
          : "",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const warning = survivorWarning(result.survivors);
    const withWarning = (msg: string) => (warning ? `${msg}\n${warning}` : msg);
    if (result.cancelled) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: withWarning(`command cancelled\n${combined}`),
      };
    }
    if (result.timedOut) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: withWarning(
          `command timed out after ${timeout}ms\n${combined}\n${/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|start|preview)\b|\b(?:vite|next|astro|nuxt)\s+(?:dev|start|preview)\b/.test(a.command) ? "For a dev server use render_check with launchCommand to keep the server and browser in one execution." : "Check the output and choose a suitable timeout in milliseconds before retrying."}`,
        ),
      };
    }
    if (result.exitCode !== 0) {
      const base = `exit ${result.exitCode}\n${combined}`;
      const writeDenied = writeRoot != null && looksLikeWriteDenial(combined);
      let errorMessage = writeDenied ? `${base}\n${boundaryAdvisory(writeRoot)}` : base;
      if (looksLikeExecutionDenial(combined))
        errorMessage +=
          "\nProcess launch was denied by the sandbox or application-control policy. Do not repeat the same launch unchanged.";
      if (this.sandbox.shell === "powershell") {
        const correction = powershellHint(a.command, combined);
        if (correction) errorMessage += `\n${correction}`;
      }
      // A Go toolchain write-denial has a precise remediation (redirect GOCACHE/GOMODCACHE into
      // the tree); surface it so the model does not rediscover it by trial. The generic advisory
      // above still names the boundary. Only meaningful under a confining sandbox.
      const goHint = writeDenied ? goToolchainSandboxHint(a.command, combined) : null;
      if (goHint) errorMessage = `${errorMessage}\n${goHint}`;
      const hint = bsdHint(a.command, combined);
      if (hint) errorMessage = `${errorMessage}\n${hint}`;
      return {
        ok: false,
        exitStatusPreserved: this.sandbox.shell === "powershell",
        errorCode: writeDenied ? "OUT_OF_TREE" : "TOOL_FAILED",
        errorMessage,
      };
    }
    return { ok: true, exitStatusPreserved: this.sandbox.shell === "powershell", output: combined };
  }
}
