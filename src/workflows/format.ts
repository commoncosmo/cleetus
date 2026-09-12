import type { WorkflowDryRun } from "./dry-run";
import type { WorkflowRunDetail, WorkflowRunRecord } from "./journal";
import type { WorkflowResultEnvelope } from "./types";

export function formatWorkflowDryRun(value: WorkflowDryRun): string {
  const steps = value.steps
    .map(
      (step, index) =>
        `${index + 1}. ${step.id} (${step.uses}) — ${step.preview}; timeout ${step.timeoutMs}ms; max attempts ${step.maximumAttempts}`,
    )
    .join("\n");
  return [
    `${value.workflow} revision ${value.revision} (${value.source})`,
    `Execution hash: ${value.executionHash}`,
    `Workflow timeout: ${value.workflowTimeoutMs}ms`,
    steps,
    value.summary,
  ].join("\n");
}

export function formatWorkflowResult(
  value: WorkflowResultEnvelope,
  presentationOutput?: string,
): string {
  if (value.status !== "succeeded") {
    return `${value.workflow}: ${value.status}${value.error ? ` — ${value.error.message}` : ""}`;
  }
  const selected =
    presentationOutput && value.outputs ? value.outputs[presentationOutput] : undefined;
  if (typeof selected === "string") return selected;
  if (
    Array.isArray(selected) &&
    selected.length > 0 &&
    selected.every((item) => typeof item === "string")
  ) {
    return selected.map((item) => `- ${item.replace(/^[-*]\s+/u, "")}`).join("\n");
  }
  return JSON.stringify(selected ?? value, null, 2);
}

export function formatWorkflowHistory(records: WorkflowRunRecord[]): string {
  if (records.length === 0) return "No workflow runs found.";
  return records
    .map(
      (record) =>
        `${record.id}  ${record.workflowName}@${record.revision}  ${record.status}  ${new Date(record.createdAt).toISOString()}`,
    )
    .join("\n");
}

function duration(startedAt?: number, endedAt?: number): string {
  if (startedAt === undefined) return "not started";
  if (endedAt === undefined) return "running";
  const milliseconds = Math.max(0, endedAt - startedAt);
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function boundedJson(value: unknown, maximum = 320): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return "";
  return encoded.length <= maximum ? encoded : `${encoded.slice(0, maximum - 1)}…`;
}

export function formatWorkflowRunDetail(detail: WorkflowRunDetail): string {
  const { run } = detail;
  const attemptsByStep = new Map<string, typeof detail.attempts>();
  for (const attempt of detail.attempts) {
    const values = attemptsByStep.get(attempt.stepId) ?? [];
    values.push(attempt);
    attemptsByStep.set(attempt.stepId, values);
  }
  const modelsByStep = new Map<string, typeof detail.modelAttempts>();
  for (const attempt of detail.modelAttempts) {
    const values = modelsByStep.get(attempt.stepId) ?? [];
    values.push(attempt);
    modelsByStep.set(attempt.stepId, values);
  }
  const lines = [
    `Run: ${run.id}`,
    `Workflow: ${run.workflowName}@${run.revision}`,
    `Status: ${run.status}`,
    `Created: ${new Date(run.createdAt).toISOString()}`,
    `Duration: ${duration(run.startedAt, run.endedAt)}`,
    `Execution hash: ${run.executionHash}`,
    "Steps:",
  ];
  const visibleSteps = detail.steps.slice(0, 50);
  for (const [index, step] of visibleSteps.entries()) {
    lines.push(
      `  ${index + 1}. ${step.stepId} (${step.uses}) — ${step.status} · ${step.attempts} attempt${step.attempts === 1 ? "" : "s"} · ${duration(step.startedAt, step.endedAt)}`,
    );
    const attempts = attemptsByStep.get(step.stepId) ?? [];
    if (attempts.length > 1 || attempts.some((attempt) => attempt.status !== "succeeded")) {
      for (const attempt of attempts.slice(0, 20)) {
        lines.push(
          `     attempt ${attempt.attempt} — ${attempt.status}${attempt.errorClass ? ` (${attempt.errorClass})` : ""} · ${duration(attempt.startedAt, attempt.endedAt)}`,
        );
      }
      if (attempts.length > 20) lines.push(`     … ${attempts.length - 20} more attempts`);
    }
    for (const model of (modelsByStep.get(step.stepId) ?? []).slice(0, 20)) {
      const served =
        model.servedModel && model.servedModel !== model.requestedModel
          ? ` → ${model.servedModel}`
          : "";
      const tokens =
        model.inputTokens !== undefined || model.outputTokens !== undefined
          ? ` · tokens ${model.inputTokens ?? "?"}→${model.outputTokens ?? "?"}`
          : "";
      lines.push(
        `     model ${model.attempt} — ${model.provider}/${model.requestedModel}${served} · ${model.finishReason ?? "unknown finish"} · ${model.constrained ? "constrained" : "unconstrained"}${tokens} · ${duration(model.startedAt, model.endedAt)}`,
      );
    }
    if ((modelsByStep.get(step.stepId)?.length ?? 0) > 20) {
      lines.push(`     … ${(modelsByStep.get(step.stepId)?.length ?? 20) - 20} more model calls`);
    }
    if (step.output !== undefined) lines.push(`     output: ${boundedJson(step.output)}`);
    if (step.error !== undefined) lines.push(`     error: ${boundedJson(step.error)}`);
  }
  if (detail.steps.length > 50) lines.push(`  … ${detail.steps.length - 50} more steps`);
  return lines.join("\n");
}
