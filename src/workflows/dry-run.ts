import { classifyWorkflowEffect } from "./executor";
import { type WorkflowPreflightSummary, formatWorkflowPreflight } from "./permissions";
import type { WorkflowExecutionPlan } from "./plan";
import { resolved } from "./provenance";
import { resolveWorkflowValue, workflowReferencesIn } from "./references";
import type { JsonObject, JsonValue } from "./types";

export interface WorkflowDryRun {
  workflow: string;
  revision: number;
  source: "project" | "global";
  packageHash: string;
  executionHash: string;
  workflowTimeoutMs: number;
  steps: Array<{
    id: string;
    uses: string;
    timeoutMs: number;
    maximumAttempts: number;
    preview: string;
  }>;
  preflight: WorkflowPreflightSummary;
  summary: string;
}

function containsReference(value: unknown): boolean {
  if (typeof value === "string") return /\$(?:inputs|steps|run|secrets)(?:\.|\b)/u.test(value);
  if (Array.isArray(value)) return value.some(containsReference);
  if (value && typeof value === "object") return Object.values(value).some(containsReference);
  return false;
}

function resolveDryRunInput(value: JsonValue, inputs: JsonObject | undefined): JsonValue {
  if (inputs === undefined) return value;
  return resolveWorkflowValue(value, {
    inputs: resolved(inputs, { untrusted: true, origins: ["workflow:inputs"] }),
    steps: {},
    run: {
      id: "<dry-run>",
      started_at: "<dry-run>",
      workspace: "<workspace>",
    },
    secrets: {},
    availableSteps: new Set(),
  }).value;
}

function previewStep(
  step: WorkflowExecutionPlan["steps"][number],
  inputs: JsonObject | undefined,
): { preview: string; value: JsonValue } {
  let value = step.with;
  try {
    value = resolveDryRunInput(step.with, inputs);
  } catch {
    // Later-step and secret references intentionally remain unresolved in a dry run.
  }
  try {
    return { preview: step.type.preview(value), value };
  } catch {
    return {
      preview: containsReference(value)
        ? "Resolved at runtime from declared references"
        : "Preview unavailable",
      value,
    };
  }
}

function effectForStep(step: WorkflowExecutionPlan["steps"][number]) {
  try {
    return step.type.classify(step.with).effect;
  } catch {
    return "side-effecting" as const;
  }
}

export function buildWorkflowDryRun(
  plan: WorkflowExecutionPlan,
  inputs?: JsonObject,
): WorkflowDryRun {
  const effects = plan.steps.map(effectForStep);
  const requiredSecrets = new Set<string>();
  const unresolved: string[] = [];
  const previews = new Map<string, { preview: string; value: JsonValue }>();
  for (const step of plan.steps) {
    const preview = previewStep(step, inputs);
    previews.set(step.id, preview);
    for (const reference of workflowReferencesIn(step.with)) {
      if (reference.namespace === "secrets" && reference.path[0]) {
        requiredSecrets.add(reference.path[0]);
      }
    }
    if (containsReference(preview.value)) unresolved.push(`steps.${step.id}.with`);
  }
  const preflight: WorkflowPreflightSummary = {
    permissions: plan.permissions,
    maximumAttempts: plan.maximumAttempts,
    maximumModelCalls: plan.maximumModelCalls,
    effect: classifyWorkflowEffect(effects),
    requiredSecrets: [...requiredSecrets].sort(),
    unresolved,
  };
  return {
    workflow: plan.package.name,
    revision: plan.manifest.revision,
    source: plan.package.source,
    packageHash: plan.package.packageHash,
    executionHash: plan.package.executionHash,
    workflowTimeoutMs: plan.workflowTimeoutMs,
    steps: plan.steps.map((step) => ({
      id: step.id,
      uses: step.uses,
      timeoutMs: step.timeoutMs,
      maximumAttempts: 1 + step.retry.attempts,
      preview: previews.get(step.id)!.preview,
    })),
    preflight,
    summary: formatWorkflowPreflight(preflight),
  };
}
