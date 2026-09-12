import { createHash } from "node:crypto";
import type { WorkflowManifest } from "../parse";
import { workflowPermissionsContain } from "../permissions";
import type { WorkflowPermissions } from "../types";
import type { AppliedWorkflowRevision } from "./revision-apply";
import type {
  WorkflowRevisionBase,
  WorkflowRevisionChangeSet,
  WorkflowRevisionOperation,
  WorkflowSemanticChange,
  WorkflowSemanticChangeCategory,
  WorkflowSemanticDiff,
} from "./types";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function summary(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const rendered = JSON.stringify(stable(value));
  return rendered.length > 240 ? `${rendered.slice(0, 237)}...` : rendered;
}

function digest(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/gu, "\n")).digest("hex");
}

function resourceSummary(content: string): string {
  return `${Buffer.byteLength(content, "utf8")} bytes sha256:${digest(content).slice(0, 12)}`;
}

interface AuthorityCapability {
  label: string;
  required: Partial<WorkflowPermissions>;
}

function runtimePermissions(manifest: WorkflowManifest): Partial<WorkflowPermissions> {
  return {
    network: (manifest.permissions.network ?? []).map((entry) => ({
      host: entry.host,
      methods: entry.methods,
    })),
    commands: (manifest.permissions.commands ?? []).map((entry) => ({
      program: entry.program,
      argsPrefix: entry.args_prefix,
    })),
    filesystem: {
      read: manifest.permissions.filesystem?.read ?? [],
      write: manifest.permissions.filesystem?.write ?? [],
    },
    model: manifest.permissions.model ?? false,
  };
}

function authority(manifest: WorkflowManifest): AuthorityCapability[] {
  return [
    ...(manifest.permissions.network ?? []).flatMap((entry) =>
      entry.methods.map((method) => ({
        label: `network:${method.toUpperCase()}:${entry.host}`,
        required: { network: [{ host: entry.host, methods: [method] }] },
      })),
    ),
    ...(manifest.permissions.commands ?? []).map((entry) => ({
      label: `command:${[entry.program, ...(entry.args_prefix ?? [])].join(" ")}`,
      required: {
        commands: [{ program: entry.program, argsPrefix: entry.args_prefix }],
      },
    })),
    ...(manifest.permissions.filesystem?.read ?? []).map((path) => ({
      label: `filesystem:read:${path}`,
      required: { filesystem: { read: [path], write: [] } },
    })),
    ...(manifest.permissions.filesystem?.write ?? []).map((path) => ({
      label: `filesystem:write:${path}`,
      required: { filesystem: { read: [], write: [path] } },
    })),
    ...(manifest.permissions.model ? [{ label: "model", required: { model: true } }] : []),
  ].sort((left, right) => left.label.localeCompare(right.label));
}

function changed(
  category: WorkflowSemanticChangeCategory,
  path: string,
  before: unknown,
  after: unknown,
  operationId?: string,
): WorkflowSemanticChange[] {
  if (equal(before, after)) return [];
  return [
    {
      id: `${category}:${path}`,
      category,
      path,
      before: summary(before),
      after: summary(after),
      operationId,
    },
  ];
}

function operationOwners(changeSet: WorkflowRevisionChangeSet) {
  const owners = new Map<string, string>();
  for (const operation of changeSet.operations) {
    switch (operation.op) {
      case "set-description":
        owners.set("metadata:description", operation.id);
        break;
      case "set-inputs":
        owners.set("inputs", operation.id);
        break;
      case "upsert-secret":
      case "remove-secret":
        owners.set(`secrets:${operation.name}`, operation.id);
        break;
      case "set-permissions":
        owners.set("permissions", operation.id);
        break;
      case "set-execution":
        owners.set("execution", operation.id);
        break;
      case "upsert-step":
        owners.set(`steps:${operation.step.id}`, operation.id);
        if (operation.placement) owners.set("steps:order", operation.id);
        break;
      case "remove-step":
        owners.set(`steps:${operation.stepId}`, operation.id);
        owners.set("steps:order", operation.id);
        break;
      case "move-step":
        owners.set("steps:order", operation.id);
        break;
      case "upsert-output":
      case "remove-output":
        owners.set(`outputs:${operation.name}`, operation.id);
        break;
      case "set-presentation":
        owners.set("presentation", operation.id);
        break;
      case "put-resource":
      case "delete-resource":
        owners.set(`resource:${operation.path}`, operation.id);
        break;
    }
  }
  return owners;
}

function namedChanges(
  category: WorkflowSemanticChangeCategory,
  prefix: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  owners: Map<string, string>,
): WorkflowSemanticChange[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .sort()
    .flatMap((name) =>
      changed(
        category,
        `${prefix}.${name}`,
        before[name],
        after[name],
        owners.get(`${prefix}:${name}`),
      ),
    );
}

export function buildWorkflowSemanticDiff(
  base: WorkflowRevisionBase,
  changeSet: WorkflowRevisionChangeSet,
  candidate: AppliedWorkflowRevision,
): WorkflowSemanticDiff {
  const owners = operationOwners(changeSet);
  const changes: WorkflowSemanticChange[] = [];
  changes.push(
    ...changed(
      "metadata",
      "description",
      base.manifest.description,
      candidate.manifest.description,
      owners.get("metadata:description"),
    ),
    ...changed(
      "inputs",
      "inputs",
      base.manifest.inputs,
      candidate.manifest.inputs,
      owners.get("inputs"),
    ),
  );
  changes.push(
    ...namedChanges(
      "secrets",
      "secrets",
      (base.manifest.secrets ?? {}) as Record<string, unknown>,
      (candidate.manifest.secrets ?? {}) as Record<string, unknown>,
      owners,
    ),
    ...changed(
      "permissions",
      "permissions",
      base.manifest.permissions,
      candidate.manifest.permissions,
      owners.get("permissions"),
    ),
    ...changed(
      "execution",
      "execution",
      base.manifest.execution,
      candidate.manifest.execution,
      owners.get("execution"),
    ),
  );
  const baseSteps = Object.fromEntries(base.manifest.steps.map((step) => [step.id, step]));
  const candidateSteps = Object.fromEntries(
    candidate.manifest.steps.map((step) => [step.id, step]),
  );
  changes.push(
    ...namedChanges("steps", "steps", baseSteps, candidateSteps, owners),
    ...changed(
      "steps",
      "steps.order",
      base.manifest.steps.map((step) => step.id),
      candidate.manifest.steps.map((step) => step.id),
      owners.get("steps:order"),
    ),
    ...namedChanges(
      "outputs",
      "outputs",
      base.manifest.outputs,
      candidate.manifest.outputs,
      owners,
    ),
    ...changed(
      "presentation",
      "presentation",
      base.manifest.presentation,
      candidate.manifest.presentation,
      owners.get("presentation"),
    ),
  );
  const baseResources = new Map(
    base.resources.map((resource) => [resource.path, resource.content]),
  );
  const candidateResources = new Map(
    candidate.resources.map((resource) => [resource.path, resource.content]),
  );
  const resourcePaths = new Set([...baseResources.keys(), ...candidateResources.keys()]);
  for (const path of [...resourcePaths].sort()) {
    const before = baseResources.get(path);
    const after = candidateResources.get(path);
    if (before === after) continue;
    const category = path.startsWith("tests/") ? "tests" : "resources";
    changes.push({
      id: `${category}:${path}`,
      category,
      path,
      before: before === undefined ? undefined : resourceSummary(before),
      after: after === undefined ? undefined : resourceSummary(after),
      operationId: owners.get(`resource:${path}`),
    });
  }

  const derivedChanges: WorkflowSemanticChange[] = [
    {
      id: "derived:revision",
      category: "derived",
      path: "revision",
      before: String(base.revision),
      after: String(candidate.manifest.revision),
    },
  ];
  const unattributedChanges = changes.filter((change) => !change.operationId);
  const basePermissions = runtimePermissions(base.manifest);
  const targetPermissions = runtimePermissions(candidate.manifest);
  const added = authority(candidate.manifest)
    .filter((capability) => !workflowPermissionsContain(basePermissions, capability.required))
    .map((capability) => capability.label);
  const removed = authority(base.manifest)
    .filter((capability) => !workflowPermissionsContain(targetPermissions, capability.required))
    .map((capability) => capability.label);
  const flags = new Set<string>();
  if (added.length) flags.add("authority increased");
  const secretNames = new Set([
    ...Object.keys(base.manifest.secrets ?? {}),
    ...Object.keys(candidate.manifest.secrets ?? {}),
  ]);
  if (
    [...secretNames].some(
      (name) =>
        !equal(
          base.manifest.secrets?.[name]?.expose_to_llm,
          candidate.manifest.secrets?.[name]?.expose_to_llm,
        ),
    )
  ) {
    flags.add("secret exposure changed");
  }
  if (changes.some((change) => change.category === "inputs")) flags.add("input contract changed");
  if (changes.some((change) => change.category === "outputs")) flags.add("output contract changed");
  const baseStepIds = base.manifest.steps.map((step) => step.id);
  const targetStepIds = candidate.manifest.steps.map((step) => step.id);
  const baseStepUses = Object.fromEntries(base.manifest.steps.map((step) => [step.id, step.uses]));
  const targetStepUses = Object.fromEntries(
    candidate.manifest.steps.map((step) => [step.id, step.uses]),
  );
  if (!equal(baseStepIds, targetStepIds) || !equal(baseStepUses, targetStepUses)) {
    flags.add("step graph changed");
  } else if (changes.some((change) => change.category === "steps")) {
    flags.add("step configuration changed");
  }
  if (changes.some((change) => change.category === "execution")) {
    flags.add("execution policy changed");
  }
  const stepPolicy = (manifest: WorkflowManifest) =>
    Object.fromEntries(
      manifest.steps.map((step) => {
        const withValue =
          step.with && typeof step.with === "object" && !Array.isArray(step.with) ? step.with : {};
        return [
          step.id,
          {
            timeout: step.timeout,
            retry: step.retry,
            provider: withValue.provider,
            model: withValue.model,
            max_output_tokens: withValue.max_output_tokens,
          },
        ];
      }),
    );
  if (!equal(stepPolicy(base.manifest), stepPolicy(candidate.manifest))) {
    flags.add("step execution policy changed");
  }
  if (changes.some((change) => change.category === "tests" && change.after === undefined)) {
    flags.add("test removed");
  }
  if (
    changes.some((change) => change.category === "resources" && change.path.startsWith("scripts/"))
  ) {
    flags.add("packaged script changed");
  }
  const onlyPresentation = changes.every(
    (change) => change.category === "presentation" || change.category === "tests",
  );
  const hasPresentation = changes.some((change) => change.category === "presentation");
  const onlyResources = changes.every(
    (change) => change.category === "resources" || change.category === "tests",
  );
  if (changes.length > 0 && hasPresentation && onlyPresentation && added.length === 0) {
    flags.add("presentation-only change");
  } else if (changes.length > 0 && onlyResources && added.length === 0) {
    flags.add("packaged resource-only change");
  }
  return {
    targetRevision: candidate.manifest.revision,
    changes,
    authority: { added, removed },
    riskFlags: [...flags],
    operationCoverage: changeSet.operations.map((operation) => ({
      operationId: operation.id,
      changeIds: changes
        .filter((change) => change.operationId === operation.id)
        .map((change) => change.id),
    })),
    derivedChanges,
    unattributedChanges,
  };
}

export function deriveLegacyWorkflowChangeSet(
  base: WorkflowRevisionBase,
  candidate: AppliedWorkflowRevision,
): WorkflowRevisionChangeSet {
  const operations: WorkflowRevisionOperation[] = [];
  const add = (operation: WorkflowRevisionOperation) => operations.push(operation);
  if (!equal(base.manifest.description, candidate.manifest.description)) {
    add({
      op: "set-description",
      id: "legacy-description",
      rationale: "Legacy full-package difference",
      description: candidate.manifest.description,
    });
  }
  if (!equal(base.manifest.inputs, candidate.manifest.inputs)) {
    add({
      op: "set-inputs",
      id: "legacy-inputs",
      rationale: "Legacy full-package difference",
      inputs: candidate.manifest.inputs,
    });
  }
  const secretNames = new Set([
    ...Object.keys(base.manifest.secrets ?? {}),
    ...Object.keys(candidate.manifest.secrets ?? {}),
  ]);
  for (const name of [...secretNames].sort()) {
    const before = base.manifest.secrets?.[name];
    const after = candidate.manifest.secrets?.[name];
    if (equal(before, after)) continue;
    if (after) {
      add({
        op: "upsert-secret",
        id: `legacy-secret-${name}`,
        rationale: "Legacy full-package difference",
        name,
        secret: after,
      });
    } else {
      add({
        op: "remove-secret",
        id: `legacy-secret-${name}`,
        rationale: "Legacy full-package difference",
        name,
      });
    }
  }
  if (!equal(base.manifest.permissions, candidate.manifest.permissions)) {
    add({
      op: "set-permissions",
      id: "legacy-permissions",
      rationale: "Legacy full-package difference",
      permissions: candidate.manifest.permissions,
    });
  }
  if (!equal(base.manifest.execution, candidate.manifest.execution)) {
    add({
      op: "set-execution",
      id: "legacy-execution",
      rationale: "Legacy full-package difference",
      execution: candidate.manifest.execution,
    });
  }
  const beforeSteps = new Map(base.manifest.steps.map((step) => [step.id, step]));
  const afterSteps = new Map(candidate.manifest.steps.map((step) => [step.id, step]));
  for (const id of [...new Set([...beforeSteps.keys(), ...afterSteps.keys()])].sort()) {
    const before = beforeSteps.get(id);
    const after = afterSteps.get(id);
    if (equal(before, after)) continue;
    if (after) {
      add({
        op: "upsert-step",
        id: `legacy-step-${id}`,
        rationale: "Legacy full-package difference",
        step: after,
        ...(before ? {} : { placement: { last: true } as const }),
      });
    } else {
      add({
        op: "remove-step",
        id: `legacy-step-${id}`,
        rationale: "Legacy full-package difference",
        stepId: id,
      });
    }
  }
  if (
    !equal(
      base.manifest.steps.map((step) => step.id),
      candidate.manifest.steps.map((step) => step.id),
    )
  ) {
    const last = candidate.manifest.steps.at(-1);
    if (last) {
      add({
        op: "move-step",
        id: "legacy-step-order",
        rationale: "Legacy full-package difference",
        stepId: last.id,
        placement: { last: true },
      });
    }
  }
  const outputNames = new Set([
    ...Object.keys(base.manifest.outputs),
    ...Object.keys(candidate.manifest.outputs),
  ]);
  for (const name of [...outputNames].sort()) {
    const before = base.manifest.outputs[name];
    const after = candidate.manifest.outputs[name];
    if (equal(before, after)) continue;
    if (after) {
      add({
        op: "upsert-output",
        id: `legacy-output-${name}`,
        rationale: "Legacy full-package difference",
        name,
        output: after,
      });
    } else {
      add({
        op: "remove-output",
        id: `legacy-output-${name}`,
        rationale: "Legacy full-package difference",
        name,
      });
    }
  }
  if (!equal(base.manifest.presentation, candidate.manifest.presentation)) {
    add({
      op: "set-presentation",
      id: "legacy-presentation",
      rationale: "Legacy full-package difference",
      presentation: candidate.manifest.presentation ?? null,
    });
  }
  const baseResources = new Map(
    base.resources.map((resource) => [resource.path, resource.content]),
  );
  const targetResources = new Map(
    candidate.resources.map((resource) => [resource.path, resource.content]),
  );
  for (const path of [...new Set([...baseResources.keys(), ...targetResources.keys()])].sort()) {
    const before = baseResources.get(path);
    const after = targetResources.get(path);
    if (before === after) continue;
    const idPath = path
      .replace(/[^a-z0-9]+/giu, "-")
      .replace(/^-|-$/gu, "")
      .toLowerCase();
    if (after !== undefined) {
      add({
        op: "put-resource",
        id: `legacy-resource-${idPath}`,
        rationale: "Legacy full-package difference",
        path,
        content: after,
      });
    } else {
      add({
        op: "delete-resource",
        id: `legacy-resource-${idPath}`,
        rationale: "Legacy full-package difference",
        path,
      });
    }
  }
  return {
    schemaVersion: 1,
    base: {
      name: base.name,
      scope: base.scope,
      revision: base.revision,
      packageHash: base.packageHash,
      executionHash: base.executionHash,
    },
    summary: "Legacy full-package revision",
    operations,
  };
}
