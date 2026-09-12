import type { WorkflowService } from "../workflows/service";
import type { JsonObject } from "../workflows/types";
import type { Tool, ToolContext, ToolResult } from "./types";

interface RunWorkflowArgs {
  name: string;
  inputs?: JsonObject;
}

export class RunWorkflowTool implements Tool {
  readonly name = "run_workflow";
  readonly description =
    "Run a named, activated strict workflow after its own exact-revision permission preflight. Use only when the user explicitly requests that workflow.";
  readonly parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Exact activated workflow name",
      },
      inputs: {
        type: "object",
        description: "Declared workflow inputs",
      },
    },
    required: ["name"],
    additionalProperties: false,
  };

  constructor(private readonly service: WorkflowService) {}

  serialize(args: unknown): string {
    return `run_workflow ${(args as RunWorkflowArgs).name}`;
  }

  async run(args: unknown, context: ToolContext): Promise<ToolResult> {
    const input = args as RunWorkflowArgs;
    if (!input.name || typeof input.name !== "string") {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: "run_workflow requires an exact workflow name",
      };
    }
    try {
      const result = await this.service.run({
        name: input.name,
        inputs: input.inputs ?? {},
        signal: context.abortSignal,
      });
      if (result.status !== "succeeded") {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: JSON.stringify(result),
        };
      }
      return { ok: true, output: JSON.stringify(result) };
    } catch (error) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: (error as Error).message,
      };
    }
  }
}
