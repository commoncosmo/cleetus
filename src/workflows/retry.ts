import type { WorkflowRetryClass, WorkflowRetryPolicy } from "./types";

export class WorkflowStepError extends Error {
  constructor(
    message: string,
    readonly errorClass: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WorkflowStepError";
  }
}

export function workflowRetryDelay(policy: WorkflowRetryPolicy, failedAttempt: number): number {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1) {
    throw new Error("failed attempt must be a positive integer");
  }
  return Math.min(
    policy.backoff.maximumMs,
    Math.floor(
      policy.backoff.initialMs * policy.backoff.multiplier ** Math.max(0, failedAttempt - 1),
    ),
  );
}

export function shouldRetryWorkflowStep(
  policy: WorkflowRetryPolicy,
  failedAttempt: number,
  errorClass: string,
  executorAllows: readonly WorkflowRetryClass[],
): boolean {
  return (
    failedAttempt <= policy.attempts &&
    policy.when.includes(errorClass as WorkflowRetryClass) &&
    executorAllows.includes(errorClass as WorkflowRetryClass)
  );
}

export function waitForWorkflowRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("workflow cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("workflow cancelled"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}
