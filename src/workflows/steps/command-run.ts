import { realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { Sandbox } from "../../sandbox/types";
import { quoteWorkflowCommand } from "../command-quote";
import { resolved } from "../provenance";
import { WorkflowStepError } from "../retry";
import type { WorkflowStepType } from "../step-registry";

interface CommandRunInput {
  program: string;
  args?: string[];
  stdin?: string;
  output: "text" | "json";
  cwd?: string;
  env?: Record<string, string>;
  max_output_bytes?: number;
}

export interface CommandRunStepDependencies {
  sandbox: Sandbox;
  packageDir: string;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function bounded(value: string, maximum: number, stream: string): string {
  const bytes = Buffer.byteLength(value);
  if (bytes > maximum) {
    throw new WorkflowStepError(`${stream} exceeds ${maximum} byte limit`, "output_limit");
  }
  return value;
}

function resolveCwd(workspace: string, cwd?: string): string {
  if (!cwd) return workspace;
  const target = resolve(workspace, cwd);
  if (!inside(realpathSync(workspace), realpathSync(target))) {
    throw new WorkflowStepError("command cwd escapes the workflow workspace", "path_escape");
  }
  return target;
}

function resolveArgs(args: string[], packageDir: string): string[] {
  const packageRoot = realpathSync(packageDir);
  return args.map((arg) => {
    if (!arg.startsWith("./scripts/")) return arg;
    const target = realpathSync(resolve(packageRoot, arg));
    if (!inside(packageRoot, target) || !statSync(target).isFile()) {
      throw new WorkflowStepError(
        `command script '${arg}' is not a verified package resource`,
        "path_escape",
      );
    }
    return target;
  });
}

export function createCommandRunStep(dependencies: CommandRunStepDependencies): WorkflowStepType {
  return {
    name: "command.run",
    version: 1,
    defaultTimeoutMs: 60_000,
    inputSchema: {
      type: "object",
      required: ["program", "output"],
      properties: {
        program: { type: "string", minLength: 1, maxLength: 4_096 },
        args: { type: "array", items: { type: "string" }, maxItems: 1_000 },
        stdin: { type: "string", maxLength: 8_388_608 },
        output: { enum: ["text", "json"] },
        cwd: { type: "string", minLength: 1 },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          maxProperties: 128,
        },
        max_output_bytes: { type: "integer", minimum: 1, maximum: 8_388_608 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["stdout", "stderr", "exit_code", "survivors"],
      properties: {
        stdout: {},
        stderr: { type: "string" },
        exit_code: { type: "integer" },
        survivors: { type: "array", items: { type: "integer" } },
      },
      additionalProperties: false,
    },
    classify(value) {
      const input = value as unknown as CommandRunInput;
      return {
        effect: "side-effecting",
        permissions: {
          commands: [{ program: input.program, argsPrefix: input.args ?? [] }],
        },
        retryable: [],
        dangerousInputPaths: ["program", "args", "cwd"],
      };
    },
    preview(value) {
      const input = value as unknown as CommandRunInput;
      return quoteWorkflowCommand(input.program, input.args ?? []);
    },
    async execute(input, context) {
      const value = input.value as unknown as CommandRunInput;
      const args = resolveArgs(value.args ?? [], dependencies.packageDir);
      const script = args.find((arg) => /\.(?:[cm]?[jt]s|tsx?)$/u.test(arg));
      if (script && (value.program !== "bun" || args[0] !== "run")) {
        throw new WorkflowStepError(
          "packaged JavaScript and TypeScript scripts must use 'bun run'",
          "invalid_command",
        );
      }
      const result = await dependencies.sandbox.exec(quoteWorkflowCommand(value.program, args), {
        cwd: resolveCwd(context.workspace, value.cwd),
        signal: context.signal,
        stdin: value.stdin,
        env: value.env,
      });
      const maximum = value.max_output_bytes ?? 1_048_576;
      const stdout = bounded(result.stdout, maximum, "command stdout");
      const stderr = bounded(result.stderr, maximum, "command stderr");
      if (result.cancelled) {
        throw new WorkflowStepError("command was cancelled", "cancelled");
      }
      if (result.timedOut) {
        throw new WorkflowStepError("command timed out", "timeout");
      }
      if (result.exitCode !== 0) {
        throw new WorkflowStepError(
          `command exited with code ${result.exitCode}; stderr: ${stderr}`,
          "command_failed",
        );
      }
      let parsed: unknown = stdout;
      if (value.output === "json") {
        try {
          parsed = JSON.parse(stdout);
        } catch {
          throw new WorkflowStepError("command stdout is not valid JSON", "invalid_json");
        }
      }
      return resolved(
        {
          stdout: parsed as never,
          stderr,
          exit_code: result.exitCode,
          survivors: result.survivors ?? [],
        },
        { untrusted: true, origins: [`command:${value.program}`] },
      );
    },
  };
}
