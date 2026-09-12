import type { ResolvedValue } from "../provenance";
import type { WorkflowSchemaService } from "../schema";
import type { WorkflowStepType } from "../step-registry";
import type { JsonSchema, JsonValue } from "../types";

interface AssertSchemaInput {
  value: JsonValue;
  schema: JsonSchema;
}

export function createAssertSchemaStep(schemas: WorkflowSchemaService): WorkflowStepType {
  return {
    name: "assert.schema",
    version: 1,
    defaultTimeoutMs: 1_000,
    inputSchema: {
      type: "object",
      required: ["value", "schema"],
      properties: {
        value: {},
        schema: { type: "object" },
      },
      additionalProperties: false,
    },
    outputSchema: {},
    classify(input) {
      const value = input as unknown as Partial<AssertSchemaInput>;
      if (value.schema && typeof value.schema === "object" && !Array.isArray(value.schema)) {
        schemas.compile(value.schema, "assert.schema input");
      }
      return { effect: "read-only", permissions: {}, retryable: [] };
    },
    preview: () => "Validate value against JSON Schema",
    async execute(input: ResolvedValue) {
      const value = input.value as unknown as AssertSchemaInput;
      const issues = schemas.compile(value.schema, "assert.schema input").validate(value.value);
      if (issues.length > 0) {
        throw new Error(
          `schema assertion failed: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
        );
      }
      return { value: value.value, provenance: input.provenance };
    },
  };
}
