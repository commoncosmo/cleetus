import type { JsonSchema } from "../types";
import type { WorkflowRevisionBase } from "./types";

export const WORKFLOW_REVISION_OPERATION_TYPES = [
  "set-description",
  "set-inputs",
  "upsert-secret",
  "remove-secret",
  "set-permissions",
  "set-execution",
  "upsert-step",
  "remove-step",
  "move-step",
  "upsert-output",
  "remove-output",
  "set-presentation",
  "put-resource",
  "delete-resource",
] as const;

export const WORKFLOW_REVISION_OPERATION_FIELDS: Record<
  (typeof WORKFLOW_REVISION_OPERATION_TYPES)[number],
  { required: readonly string[]; optional?: readonly string[] }
> = {
  "set-description": { required: ["description"] },
  "set-inputs": { required: ["inputs"] },
  "upsert-secret": { required: ["name", "secret"] },
  "remove-secret": { required: ["name"] },
  "set-permissions": { required: ["permissions"] },
  "set-execution": { required: ["execution"] },
  "upsert-step": { required: ["step"], optional: ["placement"] },
  "remove-step": { required: ["stepId"] },
  "move-step": { required: ["stepId", "placement"] },
  "upsert-output": { required: ["name", "output"] },
  "remove-output": { required: ["name"] },
  "set-presentation": { required: ["presentation"] },
  "put-resource": { required: ["path", "content"] },
  "delete-resource": { required: ["path"] },
};

export function workflowRevisionOperationFieldGuide(): string {
  return Object.entries(WORKFLOW_REVISION_OPERATION_FIELDS)
    .map(
      ([op, fields]) =>
        `${op} => ${fields.required.join(", ")}${fields.optional?.length ? `; optional: ${fields.optional.join(", ")}` : ""}`,
    )
    .join("\n");
}

const placement: JsonSchema = {
  oneOf: [
    {
      type: "object",
      required: ["before"],
      properties: { before: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["after"],
      properties: { after: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["first"],
      properties: { first: { const: true } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["last"],
      properties: { last: { const: true } },
      additionalProperties: false,
    },
  ],
};

export function workflowRevisionOutputSchema(
  base: WorkflowRevisionBase,
  manifestSchema: JsonSchema,
): JsonSchema {
  const properties = manifestSchema.properties as Record<string, JsonSchema>;
  const entityName = {
    type: "string",
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    description:
      "Exact entity key. Required by upsert-secret, remove-secret, upsert-output, and remove-output.",
  };
  // Keep the model-facing operation envelope flat. Several local constrained-
  // generation implementations choose one branch of an items.oneOf before
  // emitting the discriminator, which produces hybrid operations that are
  // difficult to repair. The host applies the exact per-op required/allowed
  // field contract before materializing any change.
  const operationSchema: JsonSchema = {
    type: "object",
    required: ["op", "id", "rationale"],
    properties: {
      op: {
        type: "string",
        enum: [...WORKFLOW_REVISION_OPERATION_TYPES],
        description: `Choose one operation and include all of its required fields:\n${workflowRevisionOperationFieldGuide()}`,
      },
      id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
      rationale: { type: "string", minLength: 1, maxLength: 500 },
      description: properties.description!,
      inputs: properties.inputs!,
      name: entityName,
      secret: (properties.secrets!.additionalProperties ?? {}) as JsonSchema,
      permissions: properties.permissions!,
      execution: properties.execution!,
      step: properties.steps!.items as JsonSchema,
      placement,
      stepId: entityName,
      output: (properties.outputs!.additionalProperties ?? {}) as JsonSchema,
      presentation: {
        anyOf: [properties.presentation!, { type: "null" }],
      },
      path: { type: "string", pattern: "^(prompts|scripts|tests)/" },
      content: { type: "string", maxLength: 32_000 },
    },
    additionalProperties: false,
  };
  return {
    type: "object",
    required: ["response", "mode", "phase", "summary", "assumptions", "unresolvedQuestions"],
    properties: {
      response: { type: "string" },
      mode: { const: "revise" },
      phase: { type: "string", enum: ["questions", "draft"] },
      summary: { type: "string" },
      changeSet: {
        type: "object",
        required: ["schemaVersion", "base", "summary", "operations"],
        properties: {
          schemaVersion: { const: 1 },
          base: {
            type: "object",
            required: ["name", "scope", "revision", "packageHash", "executionHash"],
            properties: {
              name: { const: base.name },
              scope: { const: base.scope },
              revision: { const: base.revision },
              packageHash: { const: base.packageHash },
              executionHash: { const: base.executionHash },
            },
            additionalProperties: false,
          },
          summary: { type: "string", minLength: 1, maxLength: 1_000 },
          operations: {
            type: "array",
            maxItems: 64,
            items: operationSchema,
          },
        },
        additionalProperties: false,
      },
      assumptions: { type: "array", items: { type: "string" } },
      unresolvedQuestions: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  };
}
