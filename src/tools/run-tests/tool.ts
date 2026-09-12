import type { Sandbox } from "../../sandbox/types";
import { SandboxUnavailableError } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import { applyFilter } from "./filter";
import { formatTestResult } from "./format";

export interface RunTestsConfig {
  timeoutMs: number;
  maxOutputLines: number;
}

export interface ResolvedRunner {
  runnerId: string;
  argv: string[];
  summaryRegex?: RegExp;
}

/** Lazily resolve the project's runner (re-detected while unresolved; warnings flow to the
 *  actionable error). Built by buildTestRunner; injectable for tests. */
export type RunnerResolver = (
  projectDir?: string,
  check?: "test" | "build" | "typecheck" | "lint",
) => Promise<{ runner: ResolvedRunner | null; warnings: string[] }>;

export class RunTestsTool implements Tool {
  name = "run_tests";
  // A test suite executes arbitrary project code (DB writes, generated files,
  // network); treat it as side-effectful so plan mode blocks it, like bash.
  mutates = true;
  description =
    "Run the project's test suite to verify behavior. Pass `filter` (a test-name pattern) to " +
    "run just the matching tests for a fast red→green loop; omit it to run the whole suite. " +
    "Use check: build, typecheck, or lint for those project scripts. Returns the real exit status and concise failures; prefer this tool to bash pipelines or temporary output files.";
  parameters = {
    type: "object",
    properties: {
      check: {
        type: "string",
        enum: ["test", "build", "typecheck", "lint"],
        description: "Project check to run; defaults to test.",
      },
      filter: {
        type: "string",
        description:
          "Optional test-name pattern: run only matching tests (fast red→green loop). Some runners (npm script, configured command) ignore it and run the full suite.",
      },
    },
    additionalProperties: false,
  };

  private readonly resolvedByProject = new Map<string, ResolvedRunner>();

  constructor(
    private readonly sandbox: Sandbox,
    private readonly resolveRunner: RunnerResolver,
    private readonly cfg: RunTestsConfig,
  ) {}

  serialize(): string {
    const runners = [...this.resolvedByProject.values()];
    return runners.length === 1 ? runners[0]!.argv.join(" ") : "run_tests (auto-detect)";
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const check = (args as { check?: string } | undefined)?.check ?? "test";
    if (!["test", "build", "typecheck", "lint"].includes(check))
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: "check must be test, build, typecheck, or lint",
      };
    if (check !== "test" && (args as { filter?: unknown } | undefined)?.filter)
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: "filter applies only to tests" };
    // Re-resolve: scaffolding or a repair can change the manifest/runner during the session.
    let runner: ResolvedRunner | undefined;
    {
      const resolved = await this.resolveRunner(
        ctx.projectDir,
        check as "test" | "build" | "typecheck" | "lint",
      );
      runner = resolved.runner ?? undefined;
      if (!runner) {
        const hint = resolved.warnings.length ? ` (${resolved.warnings.join("; ")})` : "";
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: `no ${check === "test" ? "test runner" : `${check} runner`} detected — add the appropriate project script or configure its command${hint}`,
        };
      }
      this.resolvedByProject.set(ctx.projectDir, runner);
    }

    const rawFilter = (args as { filter?: unknown } | undefined)?.filter;
    const filter = typeof rawFilter === "string" ? rawFilter.trim() : "";
    let argv = runner.argv;
    let note = "";
    if (filter) {
      const f = applyFilter(runner, filter);
      argv = f.argv;
      if (!f.supported) note = `(filter not supported for ${runner.runnerId}; ran full suite)\n`;
    }

    let result: Awaited<ReturnType<Sandbox["exec"]>>;
    try {
      result = await this.sandbox.exec(argv.join(" "), {
        cwd: ctx.projectDir,
        timeoutMs: this.cfg.timeoutMs,
        signal: ctx.abortSignal,
      });
    } catch (e) {
      const message = e instanceof SandboxUnavailableError ? e.message : (e as Error).message;
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: message };
    }

    if (result.cancelled) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: "✗ tests cancelled" };
    }

    const text =
      note +
      formatTestResult({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        timeoutMs: this.cfg.timeoutMs,
        maxLines: this.cfg.maxOutputLines,
        summaryRegex: runner.summaryRegex,
      });

    const verification = {
      command: argv.join(" "),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      check: check as "test" | "build" | "typecheck" | "lint",
    };
    const passed = result.exitCode === 0 && !result.timedOut;
    return passed
      ? { ok: true, output: check === "test" ? text : text.replace(/tests/g, check), verification }
      : {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: check === "test" ? text : text.replace(/tests/g, check),
          verification,
        };
  }
}
