import { describe, expect, test } from "bun:test";
import {
  shouldRetryWorkflowStep,
  waitForWorkflowRetry,
  workflowRetryDelay,
} from "../../src/workflows/retry";
import type { WorkflowRetryPolicy } from "../../src/workflows/types";

const policy: WorkflowRetryPolicy = {
  attempts: 3,
  backoff: { initialMs: 10, multiplier: 2, maximumMs: 25 },
  when: ["timeout", "connection_error"],
};

describe("workflow retry", () => {
  test("uses bounded exponential delays and additional-attempt semantics", () => {
    expect(workflowRetryDelay(policy, 1)).toBe(10);
    expect(workflowRetryDelay(policy, 2)).toBe(20);
    expect(workflowRetryDelay(policy, 3)).toBe(25);
    expect(shouldRetryWorkflowStep(policy, 3, "timeout", ["timeout"])).toBe(true);
    expect(shouldRetryWorkflowStep(policy, 4, "timeout", ["timeout"])).toBe(false);
    expect(shouldRetryWorkflowStep(policy, 1, "http_5xx", ["http_5xx"])).toBe(false);
  });

  test("cancels a pending backoff immediately", async () => {
    const controller = new AbortController();
    const waiting = waitForWorkflowRetry(10_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
  });
});
