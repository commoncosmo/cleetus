import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRunStore } from "../../src/workflows/journal";
import { resolved } from "../../src/workflows/provenance";

function create(store: WorkflowRunStore, id = "run-1") {
  return store.createRun({
    id,
    workflowName: "weather",
    revision: 1,
    packageHash: "package",
    executionHash: "execution",
    workspace: "/workspace",
    inputs: resolved({ location: "Wilmette" }, { untrusted: true }),
    steps: [{ id: "fetch", ordinal: 0, uses: "fake@1", effect: "read-only" }],
  });
}

describe("WorkflowRunStore", () => {
  it("journals a successful attempt and final output", () => {
    const store = new WorkflowRunStore(":memory:");
    create(store);
    store.setRunStatus("run-1", "running");
    const attempt = store.startStep("run-1", "fetch");
    store.succeedStep("run-1", "fetch", attempt, resolved({ body: "ok" }, { untrusted: true }));
    store.setRunStatus("run-1", "succeeded", { outputs: resolved({ result: "ok" }) });
    expect(store.getRun("run-1")).toMatchObject({
      status: "succeeded",
      outputs: { result: "ok" },
    });
    expect(store.steps("run-1")).toEqual([
      expect.objectContaining({ stepId: "fetch", status: "succeeded", attempts: 1 }),
    ]);
    expect(store.attempts("run-1")).toEqual([
      expect.objectContaining({
        stepId: "fetch",
        attempt: 1,
        status: "succeeded",
      }),
    ]);
    store.close();
  });

  it("reads bounded model-attempt authority and usage metadata for run inspection", () => {
    const store = new WorkflowRunStore(":memory:");
    create(store);
    store.recordModelAttempt({
      runId: "run-1",
      stepId: "fetch",
      attempt: 1,
      provider: "local",
      requestedModel: "model-a",
      servedModel: "model-b",
      finishReason: "stop",
      inputTokens: 20,
      outputTokens: 5,
      promptHash: "hash",
      constrained: true,
      startedAt: 10,
      endedAt: 20,
    });

    expect(store.modelAttempts("run-1")).toEqual([
      {
        runId: "run-1",
        stepId: "fetch",
        attempt: 1,
        provider: "local",
        requestedModel: "model-a",
        servedModel: "model-b",
        finishReason: "stop",
        inputTokens: 20,
        outputTokens: 5,
        promptHash: "hash",
        constrained: true,
        startedAt: 10,
        endedAt: 20,
      },
    ]);
    store.close();
  });

  it("records retries and a final failure", () => {
    const store = new WorkflowRunStore(":memory:");
    create(store);
    const first = store.startStep("run-1", "fetch");
    store.failStep("run-1", "fetch", first, {
      errorClass: "timeout",
      error: { message: "timeout" },
      final: false,
    });
    const second = store.startStep("run-1", "fetch");
    store.failStep("run-1", "fetch", second, {
      errorClass: "timeout",
      error: { message: "timeout" },
      final: true,
    });
    expect(store.steps("run-1")[0]).toMatchObject({ status: "failed", attempts: 2 });
    store.close();
  });

  it("refuses to persist sensitive inputs and outputs", () => {
    const store = new WorkflowRunStore(":memory:");
    expect(() =>
      store.createRun({
        workflowName: "secret",
        revision: 1,
        packageHash: "p",
        executionHash: "e",
        workspace: "/w",
        inputs: resolved({ token: "secret" }, { sensitive: true }),
        steps: [],
      }),
    ).toThrow("sensitive");
    create(store);
    expect(() =>
      store.setRunStatus("run-1", "succeeded", {
        outputs: resolved("secret", { sensitive: true }),
      }),
    ).toThrow("sensitive");
    store.close();
  });

  it("reconciles running records after process interruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-journal-"));
    const path = join(dir, "workflows.db");
    const first = new WorkflowRunStore(path);
    create(first);
    first.setRunStatus("run-1", "running");
    first.startStep("run-1", "fetch");
    first.close();
    const reopened = new WorkflowRunStore(path);
    expect(reopened.getRun("run-1")?.status).toBe("interrupted");
    expect(reopened.steps("run-1")[0]?.status).toBe("indeterminate");
    reopened.close();
  });

  it("pages history with a hard upper bound", () => {
    const store = new WorkflowRunStore(":memory:");
    for (let index = 0; index < 3; index++) create(store, `run-${index}`);
    expect(store.history({ limit: 2, offset: 0 })).toHaveLength(2);
    expect(store.history({ workflowName: "weather", limit: 1000, offset: 2 })).toHaveLength(1);
    store.close();
  });

  it("rolls back run creation when a step insert fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-journal-"));
    const path = join(dir, "workflows.db");
    const store = new WorkflowRunStore(path);
    store.close();
    const db = new Database(path);
    db.exec(`
      CREATE TRIGGER fail_steps BEFORE INSERT ON workflow_steps
      BEGIN SELECT RAISE(FAIL, 'step insert failed'); END;
    `);
    db.close();
    const reopened = new WorkflowRunStore(path);
    expect(() => create(reopened)).toThrow("step insert failed");
    expect(reopened.getRun("run-1")).toBeUndefined();
    reopened.close();
  });
});
