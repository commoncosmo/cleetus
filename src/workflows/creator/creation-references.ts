import type { JsonSchema, JsonValue } from "../types";

const PATH_SEGMENT = "^(?!(?:__proto__|prototype|constructor)$)[A-Za-z0-9_-]+$";
const STEP_ID = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const PATH_SEGMENT_PATTERN = new RegExp(PATH_SEGMENT, "u");
const STEP_ID_PATTERN = new RegExp(STEP_ID, "u");

export const WORKFLOW_CREATOR_REFERENCE_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: "object",
      required: ["ref", "path"],
      properties: {
        ref: { const: "input" },
        path: { type: "array", items: { type: "string", pattern: PATH_SEGMENT } },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["ref", "step", "path"],
      properties: {
        ref: { const: "step-output" },
        step: { type: "string", pattern: STEP_ID },
        path: { type: "array", items: { type: "string", pattern: PATH_SEGMENT } },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["ref", "secret", "path"],
      properties: {
        ref: { const: "secret" },
        secret: { type: "string", pattern: PATH_SEGMENT },
        path: { type: "array", items: { type: "string", pattern: PATH_SEGMENT } },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["ref", "field"],
      properties: {
        ref: { const: "run" },
        field: { enum: ["id", "started_at", "workspace"] },
      },
      additionalProperties: false,
    },
  ],
};

export const WORKFLOW_CREATOR_EXACT_REFERENCE_SCHEMA: JsonSchema = {
  oneOf: [
    WORKFLOW_CREATOR_REFERENCE_SCHEMA,
    {
      type: "string",
      pattern:
        "^\\$(?:inputs(?:\\.[A-Za-z0-9_-]+)*|steps\\.[A-Za-z0-9_-]+\\.output(?:\\.[A-Za-z0-9_-]+)*|secrets\\.[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*|run\\.(?:id|started_at|workspace))$",
    },
  ],
};

export type WorkflowCreatorReference =
  | { ref: "input"; path: string[] }
  | { ref: "step-output"; step: string; path: string[] }
  | { ref: "secret"; secret: string; path: string[] }
  | { ref: "run"; field: "id" | "started_at" | "workspace" };

function referenceRecord(value: JsonValue): WorkflowCreatorReference | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.ref !== "string"
  ) {
    return undefined;
  }
  if (value.ref === "input" && Array.isArray(value.path)) {
    return value as unknown as WorkflowCreatorReference;
  }
  if (value.ref === "step-output" && typeof value.step === "string" && Array.isArray(value.path)) {
    return value as unknown as WorkflowCreatorReference;
  }
  if (value.ref === "secret" && typeof value.secret === "string" && Array.isArray(value.path)) {
    return value as unknown as WorkflowCreatorReference;
  }
  if (value.ref === "run" && ["id", "started_at", "workspace"].includes(String(value.field))) {
    return value as unknown as WorkflowCreatorReference;
  }
  return undefined;
}

function pathSuffix(path: string[]): string {
  if (!path.every((segment) => PATH_SEGMENT_PATTERN.test(segment))) {
    throw new Error("workflow creator reference contains an invalid path segment");
  }
  return path.length > 0 ? `.${path.join(".")}` : "";
}

export function compileWorkflowCreatorReference(reference: WorkflowCreatorReference): string {
  if (reference.ref === "input") return `$inputs${pathSuffix(reference.path)}`;
  if (reference.ref === "step-output") {
    if (!STEP_ID_PATTERN.test(reference.step)) {
      throw new Error(`workflow creator reference has invalid step '${reference.step}'`);
    }
    return `$steps.${reference.step}.output${pathSuffix(reference.path)}`;
  }
  if (reference.ref === "secret") {
    if (!PATH_SEGMENT_PATTERN.test(reference.secret)) {
      throw new Error(`workflow creator reference has invalid secret '${reference.secret}'`);
    }
    return `$secrets.${reference.secret}${pathSuffix(reference.path)}`;
  }
  return `$run.${reference.field}`;
}

export function compileWorkflowCreatorValue(value: JsonValue): JsonValue {
  const reference = referenceRecord(value);
  if (reference) return compileWorkflowCreatorReference(reference);
  if (Array.isArray(value)) return value.map(compileWorkflowCreatorValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, compileWorkflowCreatorValue(child)]),
    );
  }
  return value;
}
