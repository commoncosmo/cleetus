import { parseDocument, stringify } from "yaml";
import type { WorkflowModelCallService, WorkflowModelSelection } from "../model-call";
import type { WorkflowModelCallResult } from "../model-call";
import { parseWorkflowManifest } from "../parse";
import { WorkflowSchemaService } from "../schema";
import type { JsonSchema } from "../types";
import {
  WORKFLOW_CREATOR_EXACT_REFERENCE_SCHEMA,
  WORKFLOW_CREATOR_REFERENCE_SCHEMA,
} from "./creation-references";
import { WORKFLOW_CREATOR_STEPS_SCHEMA, workflowCreatorStepSchemaFor } from "./creation-steps";
import { WORKFLOW_CREATOR_TESTS_SCHEMA } from "./creation-tests";
import {
  workflowRevisionOperationFieldGuide,
  workflowRevisionOutputSchema,
} from "./revision-schema";
import type {
  WorkflowCreatorOutput,
  WorkflowDraftRecord,
  WorkflowRequirementsContract,
  WorkflowRevisionBase,
} from "./types";

const ACTIVE_MODEL_ASSUMPTION =
  "LLM steps inherit the active provider and model unless the user explicitly chooses otherwise.";
const OPTIONAL_CONTENT_ASSUMPTION =
  "Optional content-topic and tone preferences use ordinary safe defaults unless the user specifies them.";
const STATIC_LLM_INPUT_ASSUMPTION =
  "A self-contained LLM step with no runtime data receives an explicit null input.";

export const WORKFLOW_MANIFEST_SCHEMA: JsonSchema = {
  type: "object",
  required: [
    "schema_version",
    "name",
    "revision",
    "description",
    "inputs",
    "permissions",
    "execution",
    "steps",
    "outputs",
  ],
  properties: {
    schema_version: { const: 1 },
    name: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
    revision: { type: "integer", minimum: 1 },
    description: { type: "string", minLength: 1, maxLength: 500 },
    inputs: { type: "object" },
    secrets: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["source", "name"],
        properties: {
          source: { const: "env" },
          name: { type: "string", minLength: 1 },
          expose_to_llm: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        },
        additionalProperties: false,
      },
    },
    permissions: {
      type: "object",
      properties: {
        network: {
          type: "array",
          items: {
            type: "object",
            required: ["host", "methods"],
            properties: {
              host: { type: "string", minLength: 1 },
              methods: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
            additionalProperties: false,
          },
        },
        commands: {
          type: "array",
          items: {
            type: "object",
            required: ["program"],
            properties: {
              program: { type: "string", minLength: 1 },
              args_prefix: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        },
        filesystem: {
          type: "object",
          properties: {
            read: { type: "array", items: { type: "string" } },
            write: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
        model: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execution: {
      type: "object",
      required: ["timeout"],
      properties: {
        timeout: { type: "string" },
        model: {
          type: "object",
          properties: {
            provider: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    steps: WORKFLOW_CREATOR_STEPS_SCHEMA,
    outputs: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        type: "object",
        required: ["value", "schema"],
        properties: {
          value: WORKFLOW_CREATOR_EXACT_REFERENCE_SCHEMA,
          schema: { type: "object" },
        },
        additionalProperties: false,
      },
    },
    presentation: {
      type: "object",
      required: ["output"],
      properties: {
        output: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const WORKFLOW_CREATOR_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["response", "phase", "assumptions", "unresolvedQuestions"],
  properties: {
    response: { type: "string" },
    phase: { type: "string", enum: ["questions", "draft"] },
    scope: { type: "string", enum: ["project", "global"] },
    manifest: WORKFLOW_MANIFEST_SCHEMA,
    resources: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    tests: WORKFLOW_CREATOR_TESTS_SCHEMA,
    assumptions: { type: "array", items: { type: "string" } },
    unresolvedQuestions: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

const WORKFLOW_BLUEPRINT_MANIFEST_SCHEMA: JsonSchema = {
  ...WORKFLOW_MANIFEST_SCHEMA,
  properties: {
    ...(WORKFLOW_MANIFEST_SCHEMA.properties as Record<string, JsonSchema>),
    inputs: {
      type: "object",
      properties: {
        type: { const: "object" },
        properties: {
          type: "object",
          additionalProperties: { type: "object" },
        },
        required: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        additionalProperties: {
          oneOf: [{ type: "boolean" }, { type: "object" }],
        },
        title: { type: "string" },
        description: { type: "string" },
        default: { type: "object" },
        minProperties: { type: "integer", minimum: 0 },
        maxProperties: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    outputs: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        type: "object",
        required: ["value", "schema"],
        properties: {
          value: WORKFLOW_CREATOR_REFERENCE_SCHEMA,
          schema: { type: "object" },
        },
        additionalProperties: false,
      },
    },
  },
};

export const WORKFLOW_CREATOR_BLUEPRINT_OUTPUT_SCHEMA: JsonSchema = {
  ...WORKFLOW_CREATOR_OUTPUT_SCHEMA,
  properties: {
    ...(WORKFLOW_CREATOR_OUTPUT_SCHEMA.properties as Record<string, JsonSchema>),
    manifest: WORKFLOW_BLUEPRINT_MANIFEST_SCHEMA,
    resources: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: {
            type: "string",
            pattern: "^(?:prompts|scripts)/[A-Za-z0-9._/-]+$",
          },
          content: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
};

const REQUIREMENT_VALUE_TYPES = [
  "unknown",
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "any",
] as const;

const WORKFLOW_REQUIREMENT_FIELD_SCHEMA: JsonSchema = {
  type: "object",
  required: ["path", "type", "itemType", "required", "description", "certainty", "evidence"],
  properties: {
    path: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    type: { type: "string", enum: [...REQUIREMENT_VALUE_TYPES] },
    itemType: {
      type: "string",
      enum: ["none", ...REQUIREMENT_VALUE_TYPES],
    },
    required: { type: "boolean" },
    description: { type: "string", minLength: 1 },
    certainty: {
      type: "string",
      enum: ["explicit", "conventional", "unknown"],
    },
    evidence: { type: "string" },
  },
  additionalProperties: false,
};

export const WORKFLOW_REQUIREMENTS_CONTRACT_SCHEMA: JsonSchema = {
  type: "object",
  required: [
    "phase",
    "response",
    "purpose",
    "desiredResult",
    "inputFields",
    "modelSteps",
    "externalActions",
    "secrets",
    "presentation",
    "assumptions",
    "unresolvedQuestions",
  ],
  properties: {
    phase: { type: "string", enum: ["questions", "ready"] },
    response: { type: "string" },
    purpose: { type: "string" },
    desiredResult: { type: "string" },
    inputFields: {
      type: "array",
      items: WORKFLOW_REQUIREMENT_FIELD_SCHEMA,
    },
    modelSteps: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "purpose", "outputFields"],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
          purpose: { type: "string", minLength: 1 },
          outputFields: {
            type: "array",
            minItems: 1,
            items: WORKFLOW_REQUIREMENT_FIELD_SCHEMA,
          },
        },
        additionalProperties: false,
      },
    },
    externalActions: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "description"],
        properties: {
          kind: {
            type: "string",
            enum: ["http", "command", "model", "filesystem"],
          },
          description: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    secrets: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "purpose"],
        properties: {
          name: { type: "string", minLength: 1 },
          purpose: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    presentation: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    unresolvedQuestions: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

const WORKFLOW_CREATOR_REPAIR_SCHEMA: JsonSchema = {
  type: "object",
};
const MAX_PERSISTED_ATTEMPT_CHARS = 8_000;

export interface WorkflowCreatorAttemptedResponses {
  initial: string;
  repair: string;
}

export class WorkflowCreatorResponseError extends Error {
  constructor(
    message: string,
    readonly attemptedResponses: WorkflowCreatorAttemptedResponses,
  ) {
    super(message);
    this.name = "WorkflowCreatorResponseError";
  }
}

function boundedRedactedAttempt(value: string): string {
  const redacted = value
    .replace(/(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)[^\s"',}]+/giu, "$1<redacted>")
    .replace(
      /(["']?(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*["'])[^"']*(["'])/giu,
      "$1<redacted>$2",
    );
  if (redacted.length <= MAX_PERSISTED_ATTEMPT_CHARS) return redacted;
  const tail = 2_000;
  return `${redacted.slice(0, MAX_PERSISTED_ATTEMPT_CHARS - tail)}\n…[attempt truncated]…\n${redacted.slice(-tail)}`;
}

export function workflowCreatorAttemptedResponses(
  error: unknown,
): WorkflowCreatorAttemptedResponses | undefined {
  return error instanceof WorkflowCreatorResponseError ? error.attemptedResponses : undefined;
}

export interface WorkflowCreatorModel {
  respond(input: {
    playbook: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    name?: string;
    scope: "project" | "global";
    creationProtocol?: WorkflowDraftRecord["creationProtocol"];
    requirementsContract?: WorkflowRequirementsContract;
    revisionBase?: WorkflowRevisionBase;
    signal?: AbortSignal;
  }): Promise<WorkflowCreatorOutput>;
}

function balancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}") {
      depth--;
      if (depth === 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function responseDiagnostic(result: WorkflowModelCallResult, excerptLimit = 180): string {
  const normalized = result.text.trim().replace(/\s+/gu, " ");
  const head = normalized.slice(0, excerptLimit);
  const tail = normalized.length > excerptLimit ? normalized.slice(-excerptLimit) : "";
  return [
    `provider=${result.provider}`,
    `model=${result.requestedModel}`,
    `finish=${result.finishReason ?? "unknown"}`,
    `constrained=${result.constrained}`,
    `text=${result.text.length} chars`,
    `reasoning=${result.reasoning.length} chars`,
    `head=${head ? JSON.stringify(head) : "<empty>"}`,
    tail ? `tail=${JSON.stringify(tail)}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function nonMaterialQuestionKind(
  question: string,
): "model-selection" | "optional-content" | undefined {
  const normalized = question.toLowerCase();
  if (
    normalized.includes("provider") ||
    /\b(?:which|what|preferred|choose|select)\b.{0,40}\b(?:llm\s+)?model\b/u.test(normalized) ||
    /\b(?:llm\s+)?model\b.{0,40}\b(?:use|used|choose|select|preferred)\b/u.test(normalized)
  ) {
    return "model-selection";
  }
  if (
    /\b(?:filter|filtered|filtering|avoid|exclude)\w*\b.{0,80}\b(?:topics?|tones?)\b/u.test(
      normalized,
    ) ||
    /\b(?:topics?|tones?)\b.{0,80}\b(?:filter|filtered|filtering|avoid|exclude)\w*\b/u.test(
      normalized,
    )
  ) {
    return "optional-content";
  }
  return undefined;
}

function normalizeQuestions(output: WorkflowCreatorOutput): WorkflowCreatorOutput {
  if (output.phase !== "questions") return output;
  const removed = output.unresolvedQuestions
    .map(nonMaterialQuestionKind)
    .filter((kind): kind is NonNullable<typeof kind> => kind !== undefined);
  const unresolvedQuestions = output.unresolvedQuestions.filter(
    (question) => nonMaterialQuestionKind(question) === undefined,
  );
  if (unresolvedQuestions.length === 0) {
    throw new Error(
      "workflow creator asked only non-material questions; apply the active-model and optional-content defaults, then return a draft or ask a material question",
    );
  }
  if (removed.length === 0) return output;
  const assumptions = [...output.assumptions];
  if (removed.includes("model-selection") && !assumptions.includes(ACTIVE_MODEL_ASSUMPTION)) {
    assumptions.push(ACTIVE_MODEL_ASSUMPTION);
  }
  if (removed.includes("optional-content") && !assumptions.includes(OPTIONAL_CONTENT_ASSUMPTION)) {
    assumptions.push(OPTIONAL_CONTENT_ASSUMPTION);
  }
  return {
    ...output,
    response: "Cleetus needs the material decisions listed below.",
    assumptions,
    unresolvedQuestions,
  };
}

const REQUIRED_MANIFEST_KEYS = [
  "schema_version",
  "name",
  "revision",
  "description",
  "inputs",
  "permissions",
  "execution",
  "steps",
  "outputs",
] as const;
const MANIFEST_KEYS = new Set<string>([...REQUIRED_MANIFEST_KEYS, "secrets", "presentation"]);
const CREATOR_KEYS = new Set([
  "response",
  "phase",
  "scope",
  "resources",
  "tests",
  "assumptions",
  "unresolvedQuestions",
]);

/**
 * Recover a complete manifest emitted at the creator-response root. Requiring
 * every manifest field keeps loose skill-shaped or partial objects invalid.
 */
function normalizeFlattenedCreatorManifest(value: unknown): unknown {
  const root = objectRecord(value);
  if (
    !root ||
    Object.hasOwn(root, "manifest") ||
    !REQUIRED_MANIFEST_KEYS.every((key) => Object.hasOwn(root, key))
  ) {
    return value;
  }

  const manifest = Object.fromEntries(
    Object.entries(root).filter(([key]) => MANIFEST_KEYS.has(key)),
  );
  const unknown = Object.fromEntries(
    Object.entries(root).filter(([key]) => !MANIFEST_KEYS.has(key) && !CREATOR_KEYS.has(key)),
  );
  return {
    ...unknown,
    response:
      typeof root.response === "string" && root.response.trim()
        ? root.response
        : "Workflow draft recovered for review.",
    phase: "draft",
    ...(root.scope !== undefined ? { scope: root.scope } : {}),
    manifest,
    ...(root.resources !== undefined ? { resources: root.resources } : {}),
    ...(root.tests !== undefined ? { tests: root.tests } : {}),
    assumptions: Array.isArray(root.assumptions) ? root.assumptions : [],
    unresolvedQuestions: Array.isArray(root.unresolvedQuestions) ? root.unresolvedQuestions : [],
  };
}

const VALID_STEP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NORMALIZABLE_STEP_ID = /^[a-z0-9]+(?:_[a-z0-9]+)+$/u;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeRequirementsPathMarkers(value: unknown): unknown {
  const contract = objectRecord(value);
  if (!contract) return value;
  const normalizeFields = (candidate: unknown): void => {
    if (!Array.isArray(candidate)) return;
    for (const field of candidate) {
      const record = objectRecord(field);
      if (!record || !Array.isArray(record.path)) continue;
      record.path = record.path.map((segment) =>
        Array.isArray(segment) && segment.length === 0 ? "[]" : segment,
      );
      if (typeof record.evidence !== "string") record.evidence = "";
    }
  };
  normalizeFields(contract.inputFields);
  if (Array.isArray(contract.modelSteps)) {
    for (const step of contract.modelSteps) {
      normalizeFields(objectRecord(step)?.outputFields);
    }
  }
  return contract;
}

function canonicalRequirementEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function schemaAtRequirementPath(
  root: unknown,
  path: readonly string[],
): Record<string, unknown> | undefined {
  let schema = objectRecord(root);
  for (const segment of path) {
    if (!schema) return undefined;
    if (segment === "[]") {
      schema = objectRecord(schema.items);
      continue;
    }
    schema = objectRecord(objectRecord(schema.properties)?.[segment]);
  }
  return schema;
}

function blueprintRequirementErrors(
  output: WorkflowCreatorOutput,
  contract: WorkflowRequirementsContract,
): string[] {
  if (output.phase !== "draft" || !output.manifest) return [];
  const errors: string[] = [];
  const inspect = (
    fields: WorkflowRequirementsContract["inputFields"],
    schema: unknown,
    label: string,
  ): void => {
    for (const field of fields) {
      const actual = schemaAtRequirementPath(schema, field.path);
      const display = field.path.length > 0 ? field.path.join(".") : "(complete value)";
      if (!actual) {
        errors.push(`${label} is missing required contract field ${display}`);
        continue;
      }
      if (field.type !== "any" && actual.type !== field.type) {
        errors.push(
          `${label} field ${display} has type ${String(actual.type ?? "unspecified")}; requirements require ${field.type}`,
        );
      }
      if (field.type === "array") {
        const itemType = objectRecord(actual.items)?.type;
        const itemMatches =
          field.itemType === "any" ? actual.items !== undefined : itemType === field.itemType;
        if (!itemMatches) {
          errors.push(
            `${label} array ${display} has item type ${String(itemType ?? "unspecified")}; requirements require ${field.itemType}`,
          );
        }
      }
      if (field.type === "object" && field.itemType !== "none") {
        const additionalProperties = actual.additionalProperties;
        const mapType = objectRecord(additionalProperties)?.type;
        const anyMap =
          field.itemType === "any" &&
          (additionalProperties === true || objectRecord(additionalProperties) !== undefined);
        if (!anyMap && mapType !== field.itemType) {
          errors.push(
            `${label} object ${display} has map value type ${String(mapType ?? "unspecified")}; requirements require ${field.itemType}`,
          );
        }
      }
      if (field.required && field.path.length > 0 && field.path.at(-1) !== "[]") {
        const parent = schemaAtRequirementPath(schema, field.path.slice(0, -1));
        const required = Array.isArray(parent?.required) ? parent.required : [];
        if (!required.includes(field.path.at(-1))) {
          errors.push(`${label} field ${display} must be required`);
        }
      }
    }
  };

  inspect(contract.inputFields, output.manifest.inputs, "Workflow input");
  const actualModelStepIds = output.manifest.steps
    .filter((step) => step.uses === "llm.generate@1")
    .map((step) => step.id);
  const contractedModelStepIds = contract.modelSteps.map((step) => step.id);
  for (const stepId of actualModelStepIds) {
    if (!contractedModelStepIds.includes(stepId)) {
      errors.push(`Blueprint adds uncontracted model step '${stepId}'`);
    }
  }
  for (const modelStep of contract.modelSteps) {
    const step = output.manifest.steps.find((candidate) => candidate.id === modelStep.id);
    if (!step || step.uses !== "llm.generate@1") {
      errors.push(`Blueprint is missing required model step '${modelStep.id}'`);
      continue;
    }
    const withRecord = objectRecord(step.with);
    inspect(
      modelStep.outputFields,
      withRecord?.output_schema,
      `Model step '${modelStep.id}' output`,
    );
  }
  for (const [kind, uses] of [
    ["http", "http.request@1"],
    ["command", "command.run@1"],
  ] as const) {
    const expected = contract.externalActions.filter((action) => action.kind === kind).length;
    const actual = output.manifest.steps.filter((step) => step.uses === uses).length;
    if (actual !== expected) {
      errors.push(
        `Blueprint has ${actual} ${kind} step(s); approved requirements specify ${expected}`,
      );
    }
  }
  return errors;
}

function materializeBlueprintRequirementSchemas(
  output: WorkflowCreatorOutput,
  contract: WorkflowRequirementsContract,
): WorkflowCreatorOutput {
  if (output.phase !== "draft" || !output.manifest) return output;
  const materialize = (
    fields: WorkflowRequirementsContract["inputFields"],
    schema: unknown,
  ): void => {
    for (const field of fields) {
      if (field.type !== "object" || field.itemType === "unknown") continue;
      const actual = schemaAtRequirementPath(schema, field.path);
      if (!actual || actual.type !== "object" || actual.additionalProperties !== undefined) {
        continue;
      }
      if (field.itemType === "none") {
        actual.additionalProperties = false;
      } else if (field.itemType === "any") {
        actual.additionalProperties = true;
      } else {
        actual.additionalProperties = { type: field.itemType };
      }
    }
  };

  materialize(contract.inputFields, output.manifest.inputs);
  for (const modelStep of contract.modelSteps) {
    const step = output.manifest.steps.find((candidate) => candidate.id === modelStep.id);
    if (step?.uses !== "llm.generate@1") continue;
    materialize(modelStep.outputFields, objectRecord(step.with)?.output_schema);
  }
  return output;
}

function focusedCreatorStepValidationError(value: unknown): string | undefined {
  const root = objectRecord(value);
  const manifest = objectRecord(root?.manifest);
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : undefined;
  if (!steps) return undefined;
  for (const [index, step] of steps.entries()) {
    const record = objectRecord(step);
    const uses = record?.uses;
    if (typeof uses !== "string") continue;
    const schema = workflowCreatorStepSchemaFor(uses);
    if (!schema) continue;
    const issues = new WorkflowSchemaService()
      .compile(schema, `workflow creator ${uses} schema`)
      .validate(step);
    if (issues.length === 0) continue;
    return issues
      .slice(0, 6)
      .map(
        (issue) =>
          `/manifest/steps/${index}${issue.path === "/" ? "" : issue.path}: ${issue.message}`,
      )
      .join("; ");
  }
  return undefined;
}

const BLUEPRINT_INPUT_SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "title",
  "description",
  "default",
  "minProperties",
  "maxProperties",
]);

function focusedCreatorInputValidationError(value: unknown): string | undefined {
  const root = objectRecord(value);
  const manifest = objectRecord(root?.manifest);
  const inputs = objectRecord(manifest?.inputs);
  if (!inputs) return undefined;
  const misplaced = Object.keys(inputs).filter((key) => !BLUEPRINT_INPUT_SCHEMA_KEYS.has(key));
  if (misplaced.length === 0) return undefined;
  return `/manifest/inputs: named workflow inputs ${misplaced
    .slice(0, 6)
    .map((name) => `'${name}'`)
    .join(
      ", ",
    )} must be declared under inputs.properties; set inputs.type to 'object', list required names in inputs.required, and set inputs.additionalProperties explicitly`;
}

function rewriteStepReferences(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    let rewritten = value;
    for (const [before, after] of aliases) {
      rewritten = rewritten
        .replaceAll(`$steps.${before}.`, `$steps.${after}.`)
        .replaceAll(`\${steps.${before}.`, `\${steps.${after}.`);
    }
    return rewritten;
  }
  if (Array.isArray(value)) {
    return value.map((child) => rewriteStepReferences(child, aliases));
  }
  const record = objectRecord(value);
  if (!record) return value;
  if (record.ref === "step-output" && typeof record.step === "string") {
    return {
      ...record,
      step: aliases.get(record.step) ?? record.step,
    };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, rewriteStepReferences(child, aliases)]),
  );
}

function renameAliasedKeys(
  value: unknown,
  aliases: ReadonlyMap<string, string>,
): Record<string, unknown> | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const renamed: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const target = aliases.get(key) ?? key;
    if (Object.hasOwn(renamed, target)) return undefined;
    renamed[target] = rewriteStepReferences(child, aliases);
  }
  return renamed;
}

function rewriteTestStepIdentifiers(content: string, aliases: ReadonlyMap<string, string>): string {
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return rewriteStepReferences(content, aliases) as string;
  }
  const rewritten = rewriteStepReferences(document.toJS(), aliases);
  const test = objectRecord(rewritten);
  if (!test) return rewriteStepReferences(content, aliases) as string;

  const mocks = renameAliasedKeys(test.mocks, aliases);
  if (test.mocks !== undefined && !mocks) return rewriteStepReferences(content, aliases) as string;
  if (mocks) test.mocks = mocks;

  const expect = objectRecord(test.expect);
  if (expect) {
    const attempts = renameAliasedKeys(expect.attempts, aliases);
    if (expect.attempts !== undefined && !attempts) {
      return rewriteStepReferences(content, aliases) as string;
    }
    if (attempts) expect.attempts = attempts;
    if (typeof expect.failed_step === "string") {
      expect.failed_step = aliases.get(expect.failed_step) ?? expect.failed_step;
    }
  }
  return `${JSON.stringify(test, null, 2)}\n`;
}

/**
 * Repair one narrow, common structured-generation error without weakening the
 * creator contract. Other malformed IDs remain validation errors.
 */
function normalizeCreatorStepIdentifiers(value: unknown): unknown {
  const creator = objectRecord(value);
  const manifest = objectRecord(creator?.manifest);
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : undefined;
  if (!creator || !manifest || !steps) return value;

  const aliases = new Map<string, string>();
  const normalizedIds: string[] = [];
  for (const step of steps) {
    const id = objectRecord(step)?.id;
    if (typeof id !== "string") return value;
    if (VALID_STEP_ID.test(id)) {
      normalizedIds.push(id);
      continue;
    }
    if (!NORMALIZABLE_STEP_ID.test(id)) return value;
    const normalized = id.replaceAll("_", "-");
    aliases.set(id, normalized);
    normalizedIds.push(normalized);
  }
  if (aliases.size === 0 || new Set(normalizedIds).size !== normalizedIds.length) return value;

  const rewritten = rewriteStepReferences(creator, aliases);
  const normalizedCreator = objectRecord(rewritten)!;
  const normalizedManifest = objectRecord(normalizedCreator.manifest)!;
  normalizedManifest.steps = (normalizedManifest.steps as unknown[]).map((step, index) => ({
    ...objectRecord(step),
    id: normalizedIds[index],
  }));
  if (Array.isArray(normalizedCreator.resources)) {
    normalizedCreator.resources = normalizedCreator.resources.map((resource) => {
      const record = objectRecord(resource);
      if (!record || typeof record.content !== "string") return resource;
      return {
        ...record,
        content: /^tests\/.+\.ya?ml$/u.test(String(record.path ?? ""))
          ? rewriteTestStepIdentifiers(record.content, aliases)
          : record.content,
      };
    });
  }
  return normalizedCreator;
}

export function normalizeSafeStaticLlmInput(output: WorkflowCreatorOutput): WorkflowCreatorOutput {
  const manifest = output.manifest;
  if (!manifest) return output;
  const inputProperties = manifest.inputs.properties;
  const hasDeclaredInputs =
    (inputProperties !== null &&
      typeof inputProperties === "object" &&
      !Array.isArray(inputProperties) &&
      Object.keys(inputProperties).length > 0) ||
    (Array.isArray(manifest.inputs.required) && manifest.inputs.required.length > 0);
  let changed = false;
  const steps = manifest.steps.map((step, index) => {
    if (
      index !== 0 ||
      hasDeclaredInputs ||
      step.uses !== "llm.generate@1" ||
      !step.with ||
      typeof step.with !== "object" ||
      Array.isArray(step.with) ||
      Object.hasOwn(step.with, "input")
    ) {
      return step;
    }
    const prompt = step.with.prompt;
    if (
      typeof prompt !== "string" ||
      prompt.startsWith("./prompts/") ||
      /\$(?:steps\.|\{(?:inputs|secrets)\.)/u.test(prompt)
    ) {
      return step;
    }
    changed = true;
    return {
      ...step,
      with: {
        ...step.with,
        input: null,
      },
    };
  });
  if (!changed) return output;
  const assumptions = output.assumptions.includes(STATIC_LLM_INPUT_ASSUMPTION)
    ? output.assumptions
    : [...output.assumptions, STATIC_LLM_INPUT_ASSUMPTION];
  return {
    ...output,
    assumptions,
    manifest: {
      ...manifest,
      steps,
    },
  };
}

export class StructuredWorkflowCreatorModel implements WorkflowCreatorModel {
  private readonly creationValidator = new WorkflowSchemaService().compile(
    WORKFLOW_CREATOR_OUTPUT_SCHEMA,
    "workflow creator output schema",
  );
  private readonly blueprintValidator = new WorkflowSchemaService().compile(
    WORKFLOW_CREATOR_BLUEPRINT_OUTPUT_SCHEMA,
    "workflow creator blueprint output schema",
  );
  private readonly requirementsValidator = new WorkflowSchemaService().compile(
    WORKFLOW_REQUIREMENTS_CONTRACT_SCHEMA,
    "workflow requirements contract schema",
  );

  constructor(
    private readonly calls: WorkflowModelCallService,
    private readonly selection: WorkflowModelSelection | (() => WorkflowModelSelection),
  ) {}

  private decodeRequirements(result: WorkflowModelCallResult): WorkflowRequirementsContract {
    let firstValidationError: string | undefined;
    let parsedCandidate = false;
    const channels = result.text.includes("{") ? [result.text] : [result.text, result.reasoning];
    for (const channel of channels) {
      const candidates = [
        ...new Set([channel.trim(), ...balancedJsonObjects(channel)].filter(Boolean)),
      ];
      for (const candidate of candidates) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
          parsedCandidate = true;
        } catch {
          continue;
        }
        parsed = normalizeRequirementsPathMarkers(parsed);
        const issues = this.requirementsValidator.validate(parsed);
        if (issues.length === 0) return parsed as WorkflowRequirementsContract;
        firstValidationError ??= issues
          .slice(0, 6)
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ");
      }
    }
    const kind = parsedCandidate ? "an invalid response" : "invalid JSON";
    const detail = firstValidationError ? `: ${firstValidationError}` : "";
    throw new Error(
      `workflow requirements interviewer returned ${kind}${detail} (${responseDiagnostic(result)})`,
    );
  }

  private requirementCompletenessErrors(
    contract: WorkflowRequirementsContract,
    messages: Array<{ role: "user" | "assistant"; content: string }> = [],
  ): string[] {
    const errors: string[] = [];
    const userRequirements = canonicalRequirementEvidence(
      messages
        .filter(
          (message) => message.role === "user" && !message.content.trimStart().startsWith("[Host "),
        )
        .map((message) => message.content)
        .join("\n"),
    );
    if (!contract.purpose.trim()) errors.push("The workflow purpose is not established.");
    if (!contract.desiredResult.trim()) errors.push("The desired result is not established.");

    const inspectFields = (
      fields: WorkflowRequirementsContract["inputFields"],
      label: string,
      allowRoot: boolean,
    ): void => {
      const pathKeys = new Set<string>();
      for (const field of fields) {
        const path = field.path;
        const display = path.length > 0 ? path.join(".") : "(complete value)";
        const key = JSON.stringify(path);
        if (pathKeys.has(key)) errors.push(`${label} field ${display} is declared more than once.`);
        pathKeys.add(key);
        if (!allowRoot && path.length === 0) {
          errors.push(`${label} contains an unnamed top-level field.`);
        }
        if (field.type === "unknown" || field.certainty === "unknown") {
          errors.push(`${label} field ${display} still needs an explicit value type.`);
        }
        if (field.certainty === "explicit") {
          const evidence = canonicalRequirementEvidence(field.evidence);
          if (!evidence || !userRequirements.includes(evidence)) {
            errors.push(
              `${label} field ${display} claims an explicit type without matching user wording.`,
            );
          }
        }
        const fieldName = [...path].reverse().find((segment) => segment !== "[]") ?? "";
        if (
          field.type === "string" &&
          field.certainty === "conventional" &&
          /s$/u.test(fieldName) &&
          !/(?:address|analysis|basis|class|process|progress|series|species|status|success)$/u.test(
            fieldName,
          )
        ) {
          errors.push(
            `${label} field ${display} looks collection-shaped; confirm string versus array.`,
          );
        }
        if (field.type === "array") {
          if (field.itemType === "none" || field.itemType === "unknown") {
            errors.push(`${label} array ${display} still needs an item type.`);
          }
          if (field.itemType === "object") {
            const itemPrefix = [...path, "[]"];
            const hasItemField = fields.some(
              (candidate) =>
                candidate.path.length > itemPrefix.length &&
                itemPrefix.every((segment, index) => candidate.path[index] === segment),
            );
            if (!hasItemField) errors.push(`${label} array ${display} needs declared item fields.`);
          }
        } else if (field.type !== "object" && field.itemType !== "none") {
          errors.push(`${label} field ${display} has an item type but is not an array.`);
        }
        if (field.type === "object") {
          if (field.itemType === "unknown") {
            errors.push(
              `${label} object ${display} still needs named fields or an open-map value type.`,
            );
          }
          const hasChild = fields.some(
            (candidate) =>
              candidate.path.length > path.length &&
              path.every((segment, index) => candidate.path[index] === segment),
          );
          if (field.itemType === "none" && !hasChild) {
            errors.push(`${label} object ${display} needs declared fields.`);
          }
        }
      }
    };

    inspectFields(contract.inputFields, "Input", false);
    const stepIds = new Set<string>();
    for (const step of contract.modelSteps) {
      if (stepIds.has(step.id)) errors.push(`Model step '${step.id}' is declared more than once.`);
      stepIds.add(step.id);
      inspectFields(step.outputFields, `Model step '${step.id}' output`, true);
    }
    if (contract.phase === "questions" && contract.unresolvedQuestions.length > 0) {
      // The interviewer already translated the incomplete contract into
      // reader-facing questions. Do not surround one question with duplicate
      // schema diagnostics; host checks run again after the answer.
      return [
        ...new Set(contract.unresolvedQuestions.map((question) => question.trim()).filter(Boolean)),
      ];
    }
    if (contract.phase !== "ready") {
      errors.push("The requirements interview is not complete.");
    }
    return [...new Set(errors.map((error) => error.trim()).filter(Boolean))];
  }

  private async resolveRequirements(input: {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    name?: string;
    scope: "project" | "global";
    requirementsContract?: WorkflowRequirementsContract;
    selection: WorkflowModelSelection;
    signal: AbortSignal;
  }): Promise<WorkflowRequirementsContract> {
    const system = `You are the requirements stage of a strict workflow creator.

Return only JSON matching this exact requirements contract:
${JSON.stringify(WORKFLOW_REQUIREMENTS_CONTRACT_SCHEMA)}

Establish the workflow's purpose, desired presented result, complete runtime input shapes, external actions, secrets, and the distinct output contract of every model step before executable generation.

Rules:
- Treat the workflow name as an opaque identifier. Never infer purpose or behavior from it.
- Preserve every field the user names. Flatten nested shapes into paths; use the reserved segment "[]" for array items. Example: options.[].advantages is ["options","[]","advantages"].
- Set type to unknown and certainty to unknown whenever the conversation does not establish string versus array versus object. In particular, never silently encode a plural or collection field as a string.
- For certainty explicit, copy the exact user wording that establishes the type into evidence. Use an empty evidence string for conventional or unknown types. Mentioning a field name without stating its shape is not type evidence.
- Arrays require an itemType. For arrays of objects, also declare their child fields beneath a "[]" path segment. Objects require declared child fields.
- For a closed object with named fields, set itemType to none and list its child paths. For an intentionally open string-keyed map, set itemType to its value type, or any when arbitrary JSON values are allowed; set it to unknown and ask when that distinction or value type is not established.
- A complete model output may be represented by path []. Every model step needs its own purpose-specific output fields.
- Conventional scalar defaults are allowed only when ordinary language unambiguously implies them. Schema-affecting ambiguity must become one concise question.
- Do not ask which provider or model to use; model steps inherit the active model.
- Ask only material questions that affect schemas, permissions, side effects, secrets, scope, or the step graph.
- phase may be ready only when purpose and desired result are explicit, no field type is unknown, all object/array shapes are complete, and unresolvedQuestions is empty.
- Incorporate the newest user answer into the previous contract. Do not discard already established requirements.`;
    const call = async (
      prompt: string,
      data: Record<string, unknown>,
    ): Promise<{ result: WorkflowModelCallResult; contract: WorkflowRequirementsContract }> => {
      const result = await this.calls.call({
        ...input.selection,
        system,
        prompt,
        data: JSON.stringify(data),
        outputSchema: WORKFLOW_REQUIREMENTS_CONTRACT_SCHEMA,
        maxOutputTokens: 8_192,
        signal: input.signal,
      });
      return { result, contract: this.decodeRequirements(result) };
    };

    let initial: WorkflowModelCallResult;
    try {
      const resolved = await call("Update and validate the workflow requirements contract.", {
        name: input.name,
        scope: input.scope,
        messages: input.messages,
        previousContract: input.requirementsContract,
      });
      initial = resolved.result;
      return resolved.contract;
    } catch (initialError) {
      if (input.signal.aborted) throw initialError;
      // A malformed requirements response gets one bounded structured repair,
      // just like blueprint generation, but it never advances to generation.
      const initialResult = await this.calls.call({
        ...input.selection,
        system,
        prompt: "Rebuild one complete requirements contract from the supplied conversation.",
        data: JSON.stringify({
          name: input.name,
          scope: input.scope,
          messages: input.messages,
          previousContract: input.requirementsContract,
        }),
        outputSchema: WORKFLOW_REQUIREMENTS_CONTRACT_SCHEMA,
        maxOutputTokens: 8_192,
        signal: input.signal,
      });
      initial = initialResult;
      try {
        return this.decodeRequirements(initialResult);
      } catch (repairError) {
        throw new WorkflowCreatorResponseError(
          `workflow requirements automatic JSON repair failed: ${(repairError as Error).message
            .replace(/\s*\(provider=.*$/u, "")
            .slice(0, 180)}`,
          {
            initial: boundedRedactedAttempt(
              initialError instanceof Error ? initialError.message : String(initialError),
            ),
            repair: boundedRedactedAttempt(initial.text),
          },
        );
      }
    }
  }

  private decode(
    result: WorkflowModelCallResult,
    schema: JsonSchema,
    revisionMode: boolean,
    blueprintMode: boolean,
  ): WorkflowCreatorOutput {
    const validate = revisionMode
      ? new WorkflowSchemaService().compile(schema, "workflow revision output schema")
      : blueprintMode
        ? this.blueprintValidator
        : this.creationValidator;
    let firstValidationError: string | undefined;
    let parsedCandidate = false;
    const finalTextIsJsonLike = result.text.includes("{");
    const channels = finalTextIsJsonLike ? [result.text] : [result.text, result.reasoning];
    for (const channel of channels) {
      const trimmed = channel.trim();
      const candidates = [...new Set([trimmed, ...balancedJsonObjects(channel)].filter(Boolean))];
      for (const candidate of candidates) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
          parsedCandidate = true;
        } catch {
          continue;
        }
        if (!revisionMode && !blueprintMode) {
          parsed = normalizeFlattenedCreatorManifest(parsed);
          parsed = normalizeCreatorStepIdentifiers(parsed);
        }
        const issues = validate.validate(parsed);
        if (issues.length > 0) {
          firstValidationError ??=
            (!revisionMode && blueprintMode
              ? focusedCreatorInputValidationError(parsed)
              : undefined) ??
            (!revisionMode ? focusedCreatorStepValidationError(parsed) : undefined) ??
            issues
              .slice(0, 6)
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; ");
          continue;
        }
        let output = parsed as WorkflowCreatorOutput;
        if (output.phase === "draft" && (revisionMode ? !output.changeSet : !output.manifest)) {
          firstValidationError ??= revisionMode
            ? "/changeSet is required"
            : "/manifest is required";
          continue;
        }
        try {
          output = normalizeQuestions(output);
        } catch (error) {
          firstValidationError ??= (error as Error).message;
          continue;
        }
        if (!revisionMode && !blueprintMode) {
          output = normalizeSafeStaticLlmInput(output);
        }
        if (output.manifest) {
          try {
            output.manifest = parseWorkflowManifest(
              stringify(output.manifest),
              "workflow creator manifest",
            );
          } catch (error) {
            firstValidationError ??= (error as Error).message;
            continue;
          }
        }
        return output;
      }
    }
    const kind = parsedCandidate ? "an invalid response" : "invalid JSON";
    const detail = firstValidationError ? `: ${firstValidationError}` : "";
    throw new Error(`workflow creator returned ${kind}${detail} (${responseDiagnostic(result)})`);
  }

  async respond(input: {
    playbook: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    name?: string;
    scope: "project" | "global";
    creationProtocol?: WorkflowDraftRecord["creationProtocol"];
    requirementsContract?: WorkflowRequirementsContract;
    revisionBase?: WorkflowRevisionBase;
    signal?: AbortSignal;
  }): Promise<WorkflowCreatorOutput> {
    const selection = typeof this.selection === "function" ? this.selection() : this.selection;
    const revisionMode = input.revisionBase !== undefined;
    const blueprintMode = !revisionMode && input.creationProtocol === "blueprint-v1";
    const signal = input.signal ?? new AbortController().signal;
    const requirementsContract = blueprintMode
      ? input.requirementsContract &&
        input.requirementsContract.phase === "ready" &&
        this.requirementCompletenessErrors(input.requirementsContract, input.messages).length === 0
        ? input.requirementsContract
        : await this.resolveRequirements({
            messages: input.messages,
            name: input.name,
            scope: input.scope,
            requirementsContract: input.requirementsContract,
            selection,
            signal,
          })
      : undefined;
    const requirementErrors = requirementsContract
      ? this.requirementCompletenessErrors(requirementsContract, input.messages)
      : [];
    if (requirementsContract && requirementErrors.length > 0) {
      return {
        response:
          requirementsContract.response.trim() ||
          "Cleetus needs the material decisions listed below before it can build the workflow.",
        phase: "questions",
        scope: input.scope,
        assumptions: requirementsContract.assumptions,
        unresolvedQuestions: requirementErrors,
        requirementsContract,
      };
    }
    const outputSchema = revisionMode
      ? workflowRevisionOutputSchema(input.revisionBase!, WORKFLOW_MANIFEST_SCHEMA)
      : blueprintMode
        ? WORKFLOW_CREATOR_BLUEPRINT_OUTPUT_SCHEMA
        : WORKFLOW_CREATOR_OUTPUT_SCHEMA;
    const system = `${input.playbook}

Return only JSON matching this exact creator contract:
${JSON.stringify(outputSchema)}

Use only the manifest keys and versioned step types allowed by that contract. Do not choose filesystem destinations and do not activate or execute.`;
    const interviewPolicy = `

Host-enforced interview policy:
- Treat a workflow name as an opaque identifier. Never infer its purpose, service, endpoint, inputs, actions, or desired output from the name or an abbreviation in it.
- The workflow purpose and desired result must come from explicit user statements or host-provided revision context. If either is missing, ask for it instead of substituting an assumption.
- In the questions phase, do not claim that a workflow has been drafted or present tentative mechanics as settled requirements.
- A non-expected HTTP status fails the step and prevents later steps from running. The ordinary workflow failure is already displayed as a single line. Do not claim a later template can format an HTTP failure. If the user requires a success-shaped or remote-body error result, explain that it needs explicit expected_status handling plus deterministic status-aware processing, or ask whether fail-fast output is acceptable.
- data.select@1 accepts an optional default field. Use it for a requested deterministic fallback when its JSON Pointer does not match. Do not invent host null-coalescing or introduce an LLM merely to supply that fallback.
- text.template@1 does not evaluate ||, ??, conditionals, or other expressions. Put prior-step data under with.data using an exact whole-value reference and use only {{field}}, {{path.to.field}}, or {{#each items}} syntax in the template. A newline immediately after {{#each ...}} is repeated for every item, so put the first repeated character directly after the opening tag: {{#each items}}- {{this}}\\n{{/each}}.
- In fresh creation, encode exact whole-value references as typed objects: {"ref":"input","path":["field"]}, {"ref":"step-output","step":"fetch","path":["body"]}, {"ref":"secret","secret":"token","path":[]}, or {"ref":"run","field":"workspace"}. A step-output path starts inside the executor's output value and never includes the runtime word output; use path: [] for the complete result of an LLM, selector, assertion, or template step. Use runtime interpolation strings only when embedding a scalar inside literal text. Each fresh output value should use a typed exact reference.
- For every HTTP, model, or command draft, include a structured entry in the creator response's tests array. Put the tests/*.yaml path in tests[].path and the test object in tests[].case; the host serializes it. Do not put tests in resources. Each case uses this shape: schema_version: 1; name: descriptive test name; mode: mock; inputs: {}; mocks: [<executor-discriminated entries>]; expect: { status: succeeded, outputs: { <presented-output-name>: <expected value> } }. An HTTP entry is { step: <id>, uses: "http.request@1", response: { status, content_type, final_url, body } }; a model entry is { step: <id>, uses: "llm.generate@1", value: <output-schema value> }; a command entry is { step: <id>, uses: "command.run@1", stdout: <parsed value>, stderr?: "", exit_code?: 0, survivors?: [] }; an executor failure entry is { step: <id>, uses: <external executor>, error: { message, class? } }. The host builds runtime output/error envelopes. Never add an output wrapper. Each successful case must mock every HTTP, model, and command step exactly once. Provide all required inputs except those with declared schema defaults; the host applies only those defaults and never invents other values.
- Never ask which LLM provider or model to use. Omitted provider/model fields inherit the active workflow model.
- The host derives network host/method authority from static HTTP steps, exact command authority from command steps, and model authority from LLM steps. Omit those derived permission fields. Declare only filesystem access and exceptional non-inferable authority; conflicting declarations fail compilation.
- Preserve every input and output field the user names. Object schemas must declare those properties, their types, required fields, and additionalProperties: false; do not reduce a described option or record to items: { type: object }.
- Every referenced input path must be required or guaranteed by a declared default. Give an optional object that is always passed to a step a default of {} and declare defaults for any descendants the step requires.
- When the user requests structured output but has not established the field types or whether plural fields are arrays, ask one concise contract question before drafting. Do not silently choose string versus array.
- Give each model step in a multi-model workflow its own purpose-specific output schema. Do not copy the first step's schema onto a critique, review, or refinement step unless the user explicitly requests the same contract.
- Do not block on optional content-topic filters or tone preferences. Use ordinary safe defaults unless the user supplied a preference.
- Ask only questions whose answers change schemas, permissions, side effects, secrets, scope, or the step graph.
- Step ids must use lowercase letters, digits, and hyphens only (for example, select-private, never select_private).
- command.run@1 output must be exactly text or json, never stdout. Use json for one JSON stdout value and read it through a typed step-output reference with path ["stdout"]. Packaged JavaScript or TypeScript must use its exact scripts/<name>.<ext> resource path and be invoked with program bun and args [run, ./scripts/<name>.<ext>]; never omit or guess the extension. The host derives that exact command permission. Command test mocks require stdout; stderr, exit_code, and survivors may be omitted for their host defaults. JSON-mode mock stdout is the parsed value, not a JSON string. Project-tree access uses filesystem.read [$project/**] or a narrower project path, never /. Offline command tests do not execute packaged scripts, so write reviewable deterministic code. For recursive aggregation, either mutate one shared accumulator or return and merge child-local accumulators; never do both.
- Every llm.generate@1 step must include input. Use null when its prompt is self-contained and it consumes no runtime data.
- presentation.output must be a key declared in manifest.outputs, never a $steps reference.`;
    const revisionPolicy = revisionMode
      ? `

Host-enforced revision policy:
- Return mode "revise" and a complete change set against the supplied immutable active base. Never return a complete manifest.
- Include only operations needed for the user's requested change and changes required to keep that request valid.
- Omission preserves existing manifest fields and resources. Deletion requires an explicit remove or delete-resource operation.
- Every operation needs a unique kebab-case id and a concise rationale.
- Operation id is audit metadata, not the target entity name. Include every required field exactly:
${workflowRevisionOperationFieldGuide()}
- For name, stepId, and placement references, copy the exact existing entity key from the immutable base when targeting an existing entity.
- Do not change the echoed base identity. Do not change workflow name, scope, schema version, or revision.
- Existing tests, prompts, and scripts remain byte-for-byte unchanged unless targeted by put-resource or delete-resource.
- Do not introduce llm.generate@1 for deterministic parsing, filtering, selection, sorting, numbering, templating, or formatting. Use or revise a deterministic step instead. When the base already has a command.run@1 step and the requested deterministic transformation can be expressed by that command, narrowly update that existing step and its offline test.
- On validation repair, return a new complete change set against the same base; do not patch the prior candidate.`
      : "";
    const systemWithPolicy = `${system}${interviewPolicy}${revisionPolicy}`;
    const prompt = revisionMode
      ? `Revise the active workflow ${input.revisionBase!.name} from immutable revision ${input.revisionBase!.revision}. Use the supplied base manifest and resources only as background.`
      : blueprintMode
        ? "Build one executable workflow blueprint from the supplied host-approved requirements contract. Do not reinterpret field types, omit fields, or invent additional model-output fields."
        : input.name
          ? `Continue the workflow draft named ${input.name}. Its current host scope is ${input.scope}. Reflect any explicit user scope choice in the optional scope field.`
          : `Continue the workflow creation interview. Its current host scope is ${input.scope}. Reflect any explicit user scope choice in the optional scope field.`;
    const result = await this.calls.call({
      ...selection,
      system: systemWithPolicy,
      prompt,
      data: revisionMode
        ? JSON.stringify({ messages: input.messages, revisionBase: input.revisionBase })
        : blueprintMode
          ? JSON.stringify({
              messages: input.messages,
              requirementsContract,
            })
          : JSON.stringify(input.messages),
      outputSchema,
      maxOutputTokens: 16_384,
      signal,
    });
    try {
      let output = this.decode(result, outputSchema, revisionMode, blueprintMode);
      if (requirementsContract) {
        output = materializeBlueprintRequirementSchemas(output, requirementsContract);
      }
      const contractErrors = requirementsContract
        ? blueprintRequirementErrors(output, requirementsContract)
        : [];
      if (contractErrors.length > 0) {
        throw new Error(
          `workflow blueprint contradicts approved requirements: ${contractErrors
            .slice(0, 8)
            .join("; ")}`,
        );
      }
      return requirementsContract ? { ...output, requirementsContract } : output;
    } catch (initialError) {
      if (signal.aborted) throw initialError;
      const repaired = await this.calls.call({
        ...selection,
        system: systemWithPolicy,
        prompt: blueprintMode
          ? "Discard the previous completion and rebuild one complete workflow blueprint from the original requirements. Correct the reported contract or interview-policy error without patching or copying the rejected candidate. Apply host defaults for non-material questions and return a draft when all material facts are known. Return one complete JSON object matching the contract, with no prose or Markdown fences."
          : "Repair the previous workflow-creator completion by correcting the reported contract, interview-policy, or manifest error. Apply host defaults for non-material questions and return a draft when all material facts are known. Return one complete JSON object matching the contract, with no prose or Markdown fences.",
        data: JSON.stringify({
          messages: input.messages,
          ...(requirementsContract ? { requirementsContract } : {}),
          ...(input.revisionBase ? { revisionBase: input.revisionBase } : {}),
          ...(!blueprintMode ? { previousFinalText: result.text.slice(0, 16_000) } : {}),
          failure: (initialError as Error).message.slice(0, 1_000),
        }),
        outputSchema: revisionMode || blueprintMode ? outputSchema : WORKFLOW_CREATOR_REPAIR_SCHEMA,
        maxOutputTokens: 16_384,
        signal,
      });
      try {
        let output = this.decode(repaired, outputSchema, revisionMode, blueprintMode);
        if (requirementsContract) {
          output = materializeBlueprintRequirementSchemas(output, requirementsContract);
        }
        const contractErrors = requirementsContract
          ? blueprintRequirementErrors(output, requirementsContract)
          : [];
        if (contractErrors.length > 0) {
          throw new Error(
            `workflow blueprint contradicts approved requirements: ${contractErrors
              .slice(0, 8)
              .join("; ")}`,
          );
        }
        return requirementsContract ? { ...output, requirementsContract } : output;
      } catch (repairError) {
        const repairReason = (repairError as Error).message
          .replace(/\s*\(provider=.*$/u, "")
          .slice(0, 180);
        throw new WorkflowCreatorResponseError(
          `workflow creator automatic JSON repair failed: ${repairReason}; initial [${responseDiagnostic(result, 80)}]; repair [${responseDiagnostic(repaired, 80)}]`,
          {
            initial: boundedRedactedAttempt(result.text),
            repair: boundedRedactedAttempt(repaired.text),
          },
        );
      }
    }
  }
}
