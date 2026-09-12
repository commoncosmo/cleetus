import { type WorkflowEventSink, emitWorkflowEvent } from "./events";
import type { WorkflowRunStore } from "./journal";
import { workflowPermissionsContain } from "./permissions";
import type { WorkflowExecutionPlan } from "./plan";
import type { ResolvedValue } from "./provenance";
import { mergeProvenance, resolved } from "./provenance";
import { resolveWorkflowValue } from "./references";
import {
  WorkflowStepError,
  shouldRetryWorkflowStep,
  waitForWorkflowRetry,
  workflowRetryDelay,
} from "./retry";
import type { JsonObject, JsonValue, WorkflowPermissions } from "./types";

export interface ExecuteWorkflowInput {
  plan: WorkflowExecutionPlan;
  runId: string;
  workspace: string;
  startedAt: string;
  inputs: ResolvedValue;
  secrets: Record<string, ResolvedValue>;
  approvedPermissions: WorkflowPermissions;
  store: WorkflowRunStore;
  signal?: AbortSignal;
  events?: WorkflowEventSink;
}

function abortError(signal: AbortSignal): WorkflowStepError {
  const reason = signal.reason;
  return new WorkflowStepError(
    reason instanceof Error ? reason.message : "workflow cancelled",
    "cancelled",
  );
}

function stepTimeoutError(stepId: string, timeoutMs: number): WorkflowStepError {
  const duration = timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`;
  return new WorkflowStepError(
    `workflow step '${stepId}' timed out after ${duration}`,
    "timeout",
    true,
  );
}

function timedSignal(
  parent: AbortSignal,
  ms: number,
): {
  signal: AbortSignal;
  dispose(): void;
  timedOut(): boolean;
} {
  const controller = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new WorkflowStepError("workflow step timed out", "timeout", true));
  }, ms);
  const onAbort = () => controller.abort(parent.reason ?? new Error("workflow cancelled"));
  parent.addEventListener("abort", onAbort, { once: true });
  if (parent.aborted) onAbort();
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

function errorDetails(error: unknown): { errorClass: string; value: JsonValue } {
  const message = error instanceof Error ? error.message : String(error);
  const errorClass = error instanceof WorkflowStepError ? error.errorClass : "executor_error";
  return { errorClass, value: { code: errorClass, message } };
}

function mostSevereEffect(
  effects: Array<"read-only" | "idempotent" | "side-effecting">,
): "read-only" | "idempotent" | "side-effecting" {
  if (effects.includes("side-effecting")) return "side-effecting";
  if (effects.includes("idempotent")) return "idempotent";
  return "read-only";
}

export async function executeWorkflow(
  input: ExecuteWorkflowInput,
): Promise<ResolvedValue<JsonObject>> {
  if (
    !workflowPermissionsContain(input.approvedPermissions, input.plan.permissions, input.workspace)
  ) {
    throw new WorkflowStepError(
      "approved workflow grant does not cover the execution plan",
      "permission_denied",
    );
  }
  const workflowController = new AbortController();
  const externalSignal = input.signal;
  const onExternalAbort = () =>
    workflowController.abort(externalSignal?.reason ?? new Error("workflow cancelled"));
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal?.aborted) onExternalAbort();
  const workflowTimer = setTimeout(
    () => workflowController.abort(new WorkflowStepError("workflow timed out", "timeout", false)),
    input.plan.workflowTimeoutMs,
  );
  const outputs: Record<string, { output: ResolvedValue }> = {};
  const availableSteps = new Set<string>();
  input.store.setRunStatus(input.runId, "running");
  await emitWorkflowEvent(input.events, {
    type: "run_status",
    runId: input.runId,
    workflow: input.plan.package.name,
    revision: input.plan.manifest.revision,
    totalSteps: input.plan.steps.length,
    status: "running",
  });
  try {
    for (const step of input.plan.steps) {
      if (workflowController.signal.aborted) throw abortError(workflowController.signal);
      const referenceContext = {
        inputs: input.inputs,
        steps: outputs,
        run: {
          id: input.runId,
          started_at: input.startedAt,
          workspace: input.workspace,
        },
        secrets: input.secrets,
        availableSteps,
      };
      let completed = false;
      while (!completed) {
        const resolvedInput = resolveWorkflowValue(step.with, referenceContext);
        const validation = step.inputValidator.validate(resolvedInput.value);
        if (validation.length) {
          throw new WorkflowStepError(
            `step '${step.id}' input failed schema validation: ${validation[0]!.message}`,
            "validation_error",
          );
        }
        const classification = step.type.classify(resolvedInput.value);
        if (
          classification.dangerousInputPaths?.length &&
          resolvedInput.provenance.untrusted &&
          !step.allowUntrustedInput
        ) {
          throw new WorkflowStepError(
            `step '${step.id}' routes untrusted data to a dangerous input`,
            "untrusted_input",
          );
        }
        if (
          !workflowPermissionsContain(
            input.approvedPermissions,
            classification.permissions,
            input.workspace,
          )
        ) {
          throw new WorkflowStepError(
            `step '${step.id}' requires authority outside the approved grant`,
            "permission_denied",
          );
        }
        const attempt = input.store.startStep(input.runId, step.id);
        await emitWorkflowEvent(input.events, {
          type: "step_status",
          runId: input.runId,
          workflow: input.plan.package.name,
          stepId: step.id,
          ordinal: step.ordinal + 1,
          totalSteps: input.plan.steps.length,
          uses: step.uses,
          status: "running",
          attempt,
        });
        const deadline = timedSignal(workflowController.signal, step.timeoutMs);
        try {
          const output = await step.type.execute(resolvedInput, {
            signal: deadline.signal,
            runId: input.runId,
            stepId: step.id,
            workspace: input.workspace,
            permissions: input.approvedPermissions,
          });
          if (deadline.signal.aborted) {
            throw deadline.timedOut()
              ? stepTimeoutError(step.id, step.timeoutMs)
              : abortError(deadline.signal);
          }
          const outputIssues = step.outputValidator.validate(output.value);
          if (outputIssues.length) {
            throw new WorkflowStepError(
              `step '${step.id}' output failed schema validation: ${outputIssues[0]!.message}`,
              "validation_error",
            );
          }
          input.store.succeedStep(input.runId, step.id, attempt, output);
          outputs[step.id] = { output };
          availableSteps.add(step.id);
          completed = true;
          await emitWorkflowEvent(input.events, {
            type: "step_status",
            runId: input.runId,
            workflow: input.plan.package.name,
            stepId: step.id,
            ordinal: step.ordinal + 1,
            totalSteps: input.plan.steps.length,
            uses: step.uses,
            status: "succeeded",
            attempt,
          });
        } catch (caught) {
          const error = deadline.timedOut() ? stepTimeoutError(step.id, step.timeoutMs) : caught;
          const details = errorDetails(error);
          const cancelled = workflowController.signal.aborted && details.errorClass !== "timeout";
          if (cancelled) {
            input.store.cancelStep(input.runId, step.id, attempt, details.value);
            throw error;
          }
          const retry = shouldRetryWorkflowStep(
            step.retry,
            attempt,
            details.errorClass,
            classification.retryable,
          );
          input.store.failStep(input.runId, step.id, attempt, {
            errorClass: details.errorClass,
            error: details.value,
            final: !retry,
          });
          if (!retry) throw error;
          await waitForWorkflowRetry(
            workflowRetryDelay(step.retry, attempt),
            workflowController.signal,
          );
        } finally {
          deadline.dispose();
        }
      }
    }
    const finalValues: JsonObject = {};
    const finalProvenance = [];
    for (const output of input.plan.outputs) {
      const selected = resolveWorkflowValue(output.value, {
        inputs: input.inputs,
        steps: outputs,
        run: {
          id: input.runId,
          started_at: input.startedAt,
          workspace: input.workspace,
        },
        secrets: input.secrets,
        availableSteps,
      });
      const issues = output.validator.validate(selected.value);
      if (issues.length) {
        throw new WorkflowStepError(
          `workflow output '${output.name}' failed schema validation: ${issues[0]!.message}`,
          "validation_error",
        );
      }
      finalValues[output.name] = selected.value;
      finalProvenance.push(selected.provenance);
    }
    const result = resolved(finalValues, mergeProvenance(finalProvenance));
    input.store.setRunStatus(input.runId, "succeeded", { outputs: result });
    await emitWorkflowEvent(input.events, {
      type: "run_output",
      runId: input.runId,
      outputs: finalValues,
    });
    await emitWorkflowEvent(input.events, {
      type: "run_status",
      runId: input.runId,
      workflow: input.plan.package.name,
      revision: input.plan.manifest.revision,
      totalSteps: input.plan.steps.length,
      status: "succeeded",
    });
    return result;
  } catch (error) {
    const details = errorDetails(error);
    const cancelled = workflowController.signal.aborted && details.errorClass !== "timeout";
    input.store.setRunStatus(input.runId, cancelled ? "cancelled" : "failed", {
      error: details.value,
    });
    await emitWorkflowEvent(input.events, {
      type: "run_status",
      runId: input.runId,
      workflow: input.plan.package.name,
      revision: input.plan.manifest.revision,
      totalSteps: input.plan.steps.length,
      status: cancelled ? "cancelled" : "failed",
    });
    throw error;
  } finally {
    clearTimeout(workflowTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

export function classifyWorkflowEffect(
  effects: Array<"read-only" | "idempotent" | "side-effecting">,
): "read-only" | "idempotent" | "side-effecting" {
  return mostSevereEffect(effects);
}
