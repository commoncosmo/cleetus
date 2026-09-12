import type { WorkflowManifest } from "../parse";
import type { JsonSchema } from "../types";
import { compileWorkflowCreatorValue } from "./creation-references";

const STEP_ID_SCHEMA: JsonSchema = {
  type: "string",
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
};

const RETRY_SCHEMA: JsonSchema = {
  type: "object",
  required: ["attempts", "backoff", "when"],
  properties: {
    attempts: { type: "integer", minimum: 0, maximum: 10 },
    backoff: {
      type: "object",
      required: ["initial", "multiplier", "maximum"],
      properties: {
        initial: { type: "string" },
        multiplier: { type: "number", minimum: 1, maximum: 10 },
        maximum: { type: "string" },
      },
      additionalProperties: false,
    },
    when: {
      type: "array",
      maxItems: 10,
      items: {
        enum: ["timeout", "connection_error", "http_429", "http_5xx", "provider_error"],
      },
    },
  },
  additionalProperties: false,
};

const JSON_SCHEMA: JsonSchema = { type: "object" };
const STRING_MAP_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: { type: "string" },
};

function stepBranch(
  uses: string,
  requiredWith: string[],
  withProperties: Record<string, JsonSchema>,
): JsonSchema {
  return {
    type: "object",
    required: ["id", "uses", "with"],
    properties: {
      id: STEP_ID_SCHEMA,
      uses: { const: uses },
      timeout: { type: "string" },
      retry: RETRY_SCHEMA,
      allow_untrusted_input: { type: "boolean" },
      with: {
        type: "object",
        required: requiredWith,
        properties: withProperties,
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}

const HTTP_QUERY_VALUE_SCHEMA: JsonSchema = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    {
      type: "array",
      items: {
        oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
      },
    },
  ],
};

const WORKFLOW_CREATOR_STEP_SCHEMAS: Record<string, JsonSchema> = {
  "http.request@1": stepBranch("http.request@1", ["url"], {
    url: { type: "string", minLength: 1, maxLength: 8_192 },
    method: { type: "string", pattern: "^[A-Za-z]+$" },
    query: {
      type: "object",
      additionalProperties: HTTP_QUERY_VALUE_SCHEMA,
    },
    headers: STRING_MAP_SCHEMA,
    body: {},
    expected_status: {
      type: "array",
      items: { type: "integer", minimum: 100, maximum: 599 },
    },
    expected_content_type: { type: "string" },
    response: { enum: ["json", "text"] },
    max_response_bytes: { type: "integer", minimum: 1, maximum: 8_388_608 },
    idempotency_key: { type: "string", minLength: 1 },
    allow_unsafe_retry: { type: "boolean" },
  }),
  "llm.generate@1": stepBranch("llm.generate@1", ["prompt", "input", "output_schema"], {
    prompt: { type: "string", minLength: 1, maxLength: 1_048_576 },
    input: {},
    output_schema: JSON_SCHEMA,
    provider: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    max_output_tokens: { type: "integer", minimum: 1, maximum: 65_536 },
    repair_attempts: { type: "integer", minimum: 0, maximum: 3 },
  }),
  "command.run@1": stepBranch("command.run@1", ["program", "output"], {
    program: { type: "string", minLength: 1, maxLength: 4_096 },
    args: { type: "array", items: { type: "string" }, maxItems: 1_000 },
    stdin: { type: "string", maxLength: 8_388_608 },
    output: { enum: ["text", "json"] },
    cwd: { type: "string", minLength: 1 },
    env: { ...STRING_MAP_SCHEMA, maxProperties: 128 },
    max_output_bytes: { type: "integer", minimum: 1, maximum: 8_388_608 },
  }),
  "data.select@1": stepBranch("data.select@1", ["value", "pointer"], {
    value: {},
    pointer: { type: "string" },
    default: {},
  }),
  "text.template@1": stepBranch("text.template@1", ["template", "data"], {
    template: { type: "string", maxLength: 100_000 },
    data: {},
  }),
  "assert.schema@1": stepBranch("assert.schema@1", ["value", "schema"], {
    value: {},
    schema: JSON_SCHEMA,
  }),
};

export const WORKFLOW_CREATOR_STEP_SCHEMA: JsonSchema = {
  oneOf: Object.values(WORKFLOW_CREATOR_STEP_SCHEMAS),
};

export const WORKFLOW_CREATOR_STEPS_SCHEMA: JsonSchema = {
  type: "array",
  minItems: 1,
  items: WORKFLOW_CREATOR_STEP_SCHEMA,
};

export function workflowCreatorStepSchemaFor(uses: string): JsonSchema | undefined {
  return WORKFLOW_CREATOR_STEP_SCHEMAS[uses];
}

/**
 * Compile the executor-discriminated creator representation to the unchanged
 * v1 manifest step representation. Validation has already removed fields that
 * do not belong to the selected executor branch.
 */
export function compileWorkflowCreatorSteps(
  steps: WorkflowManifest["steps"],
): WorkflowManifest["steps"] {
  return steps.map((step) => ({
    ...step,
    with:
      step.with && typeof step.with === "object" && !Array.isArray(step.with)
        ? (compileWorkflowCreatorValue(step.with) as WorkflowManifest["steps"][number]["with"])
        : step.with,
  }));
}
