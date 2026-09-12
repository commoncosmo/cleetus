import { stringify } from "yaml";
import { type WorkflowManifest, parseWorkflowManifest } from "../parse";
import { WORKFLOW_REVISION_OPERATION_FIELDS } from "./revision-schema";
import type {
  WorkflowCreatorResource,
  WorkflowRevisionBase,
  WorkflowRevisionChangeSet,
  WorkflowRevisionOperation,
  WorkflowStepPlacement,
} from "./types";

const OPERATION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ENTITY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_OPERATIONS = 64;
const MAX_RESOURCE_BYTES = 32_000;
const MAX_TOTAL_RESOURCE_BYTES = 64_000;
const COMMON_OPERATION_FIELDS = ["op", "id", "rationale"] as const;

export interface AppliedWorkflowRevision {
  manifest: WorkflowManifest;
  resources: WorkflowCreatorResource[];
}

function fail(operation: WorkflowRevisionOperation | undefined, message: string): never {
  throw new Error(
    operation ? `revision operation '${operation.id}' (${operation.op}): ${message}` : message,
  );
}

function validateOperationShape(operation: WorkflowRevisionOperation, index: number): void {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    fail(undefined, `revision operation ${index + 1} must be an object`);
  }
  const record = operation as unknown as Record<string, unknown>;
  if (
    typeof record.op !== "string" ||
    !Object.hasOwn(WORKFLOW_REVISION_OPERATION_FIELDS, record.op)
  ) {
    fail(undefined, `revision operation ${index + 1} has unsupported op '${String(record.op)}'`);
  }
  if (typeof record.id !== "string") {
    fail(undefined, `revision operation ${index + 1} requires a string id`);
  }
  if (typeof record.rationale !== "string") {
    fail(operation, "rationale must be a string");
  }
  const contract = WORKFLOW_REVISION_OPERATION_FIELDS[record.op as WorkflowRevisionOperation["op"]];
  for (const field of contract.required) {
    if (!Object.hasOwn(record, field)) fail(operation, `missing required field '${field}'`);
  }
  const allowed = new Set([
    ...COMMON_OPERATION_FIELDS,
    ...contract.required,
    ...(contract.optional ?? []),
  ]);
  const unexpected = Object.keys(record).filter((field) => !allowed.has(field));
  if (unexpected.length > 0) {
    fail(operation, `field '${unexpected[0]}' is not allowed for ${record.op}`);
  }
  for (const field of ["description", "name", "stepId", "path", "content"] as const) {
    if (Object.hasOwn(record, field) && typeof record[field] !== "string") {
      fail(operation, `field '${field}' must be a string`);
    }
  }
}

function sameBase(base: WorkflowRevisionBase, changeSet: WorkflowRevisionChangeSet): boolean {
  return (
    changeSet.base.name === base.name &&
    changeSet.base.scope === base.scope &&
    changeSet.base.revision === base.revision &&
    changeSet.base.packageHash === base.packageHash &&
    changeSet.base.executionHash === base.executionHash
  );
}

function safeResourcePath(path: string): boolean {
  return (
    /^(?:prompts|scripts|tests)\/[^\\\0]+$/u.test(path) &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function placementIndex(
  steps: WorkflowManifest["steps"],
  placement: WorkflowStepPlacement,
  movingId?: string,
): number {
  if ("first" in placement) return 0;
  if ("last" in placement) return steps.length;
  const reference = "before" in placement ? placement.before : placement.after;
  if (reference === movingId) throw new Error("step placement cannot reference itself");
  const index = steps.findIndex((step) => step.id === reference);
  if (index < 0) throw new Error(`placement references missing step '${reference}'`);
  return "before" in placement ? index : index + 1;
}

function targetKeys(operation: WorkflowRevisionOperation): string[] {
  switch (operation.op) {
    case "set-description":
      return ["manifest:description"];
    case "set-inputs":
      return ["manifest:inputs"];
    case "upsert-secret":
    case "remove-secret":
      return [`secret:${operation.name}`];
    case "set-permissions":
      return ["manifest:permissions"];
    case "set-execution":
      return ["manifest:execution"];
    case "upsert-step":
      return [
        `step:${operation.step.id}`,
        ...(operation.placement ? [`step-placement:${operation.step.id}`] : []),
      ];
    case "remove-step":
      return [`step:${operation.stepId}`];
    case "move-step":
      return [`step-placement:${operation.stepId}`];
    case "upsert-output":
    case "remove-output":
      return [`output:${operation.name}`];
    case "set-presentation":
      return ["manifest:presentation"];
    case "put-resource":
    case "delete-resource":
      return [`resource:${operation.path}`];
  }
}

export function validateWorkflowRevisionChangeSet(
  base: WorkflowRevisionBase,
  changeSet: WorkflowRevisionChangeSet,
): void {
  if (changeSet.schemaVersion !== 1) fail(undefined, "revision change-set schemaVersion must be 1");
  if (!sameBase(base, changeSet)) fail(undefined, "revision change set does not match its base");
  if (!changeSet.summary.trim()) fail(undefined, "revision change set requires a summary");
  if (changeSet.operations.length > MAX_OPERATIONS) {
    fail(undefined, `revision change set exceeds ${MAX_OPERATIONS} operations`);
  }
  const ids = new Set<string>();
  const targets = new Map<string, string>();
  let resourceBytes = 0;
  for (const [index, operation] of changeSet.operations.entries()) {
    validateOperationShape(operation, index);
    if (!OPERATION_ID.test(operation.id)) fail(operation, "id must be kebab-case");
    if (ids.has(operation.id)) fail(operation, "operation id is duplicated");
    ids.add(operation.id);
    if (!operation.rationale.trim()) fail(operation, "rationale is required");
    for (const target of targetKeys(operation)) {
      const owner = targets.get(target);
      if (owner) fail(operation, `target '${target}' is already owned by '${owner}'`);
      targets.set(target, operation.id);
    }
    if ("name" in operation && !ENTITY_NAME.test(operation.name)) {
      fail(operation, "entity name must be kebab-case");
    }
    if (
      (operation.op === "put-resource" || operation.op === "delete-resource") &&
      !safeResourcePath(operation.path)
    ) {
      fail(operation, "resource path must stay under prompts/, scripts/, or tests/");
    }
    if (operation.op === "put-resource") {
      const bytes = Buffer.byteLength(operation.content, "utf8");
      if (bytes > MAX_RESOURCE_BYTES) {
        fail(operation, `resource exceeds ${MAX_RESOURCE_BYTES} bytes`);
      }
      resourceBytes += bytes;
    }
  }
  if (resourceBytes > MAX_TOTAL_RESOURCE_BYTES) {
    fail(undefined, `revision resources exceed ${MAX_TOTAL_RESOURCE_BYTES} bytes`);
  }
}

function applyOperation(
  manifest: WorkflowManifest,
  resources: Map<string, WorkflowCreatorResource>,
  operation: WorkflowRevisionOperation,
): void {
  switch (operation.op) {
    case "set-description":
      manifest.description = operation.description;
      return;
    case "set-inputs":
      manifest.inputs = structuredClone(operation.inputs);
      return;
    case "upsert-secret":
      manifest.secrets = {
        ...(manifest.secrets ?? {}),
        [operation.name]: structuredClone(operation.secret),
      };
      return;
    case "remove-secret":
      if (!manifest.secrets || !(operation.name in manifest.secrets)) {
        fail(operation, `secret '${operation.name}' does not exist`);
      }
      delete manifest.secrets[operation.name];
      if (Object.keys(manifest.secrets).length === 0) manifest.secrets = undefined;
      return;
    case "set-permissions":
      manifest.permissions = structuredClone(operation.permissions);
      return;
    case "set-execution":
      manifest.execution = structuredClone(operation.execution);
      return;
    case "upsert-step": {
      const existing = manifest.steps.findIndex((step) => step.id === operation.step.id);
      if (existing >= 0) {
        manifest.steps[existing] = structuredClone(operation.step);
        if (!operation.placement) return;
        const [step] = manifest.steps.splice(existing, 1);
        manifest.steps.splice(
          placementIndex(manifest.steps, operation.placement, operation.step.id),
          0,
          step!,
        );
        return;
      }
      if (!operation.placement) fail(operation, "new step requires placement");
      manifest.steps.splice(
        placementIndex(manifest.steps, operation.placement),
        0,
        structuredClone(operation.step),
      );
      return;
    }
    case "remove-step": {
      const index = manifest.steps.findIndex((step) => step.id === operation.stepId);
      if (index < 0) fail(operation, `step '${operation.stepId}' does not exist`);
      manifest.steps.splice(index, 1);
      return;
    }
    case "move-step": {
      const index = manifest.steps.findIndex((step) => step.id === operation.stepId);
      if (index < 0) fail(operation, `step '${operation.stepId}' does not exist`);
      const [step] = manifest.steps.splice(index, 1);
      manifest.steps.splice(
        placementIndex(manifest.steps, operation.placement, operation.stepId),
        0,
        step!,
      );
      return;
    }
    case "upsert-output":
      manifest.outputs[operation.name] = structuredClone(operation.output);
      return;
    case "remove-output":
      if (!(operation.name in manifest.outputs)) {
        fail(operation, `output '${operation.name}' does not exist`);
      }
      delete manifest.outputs[operation.name];
      return;
    case "set-presentation":
      if (operation.presentation === null) manifest.presentation = undefined;
      else manifest.presentation = structuredClone(operation.presentation);
      return;
    case "put-resource":
      resources.set(operation.path, { path: operation.path, content: operation.content });
      return;
    case "delete-resource":
      if (!resources.delete(operation.path)) {
        fail(operation, `resource '${operation.path}' does not exist`);
      }
      return;
  }
}

export function applyWorkflowRevision(
  base: WorkflowRevisionBase,
  changeSet: WorkflowRevisionChangeSet,
): AppliedWorkflowRevision {
  validateWorkflowRevisionChangeSet(base, changeSet);
  const manifest = structuredClone(base.manifest);
  const resources = new Map(
    base.resources.map((resource) => [resource.path, structuredClone(resource)]),
  );
  for (const operation of changeSet.operations) applyOperation(manifest, resources, operation);
  manifest.revision = base.revision + 1;
  return {
    manifest: parseWorkflowManifest(stringify(manifest), "materialized workflow revision"),
    resources: [...resources.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}
