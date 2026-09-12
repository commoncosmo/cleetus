import { describe, expect, test } from "bun:test";
import { executeWorkflow } from "../../src/workflows/executor";
import { WorkflowRunStore } from "../../src/workflows/journal";
import type { WorkflowPackage } from "../../src/workflows/package";
import type { WorkflowExecutionPlan } from "../../src/workflows/plan";
import { resolved } from "../../src/workflows/provenance";
import { WorkflowStepError } from "../../src/workflows/retry";
import { WorkflowSchemaService } from "../../src/workflows/schema";
import type { WorkflowStepType } from "../../src/workflows/step-registry";
import type { JsonValue } from "../../src/workflows/types";

const schemas = new WorkflowSchemaService();
const noPermissions = {
  network: [],
  commands: [],
  filesystem: { read: [], write: [] },
  model: false,
};

function plan(types: WorkflowStepType[], retryAttempts = 0): WorkflowExecutionPlan {
  const manifest = {
    schema_version: 1 as const,
    name: "test",
    revision: 1,
    description: "test",
    inputs: { type: "object" },
    permissions: {},
    execution: { timeout: "5s" },
    steps: [],
    outputs: {},
  };
  return {
    package: {
      name: "test",
      description: "test",
      source: "project",
      dir: "/work/test",
      manifestPath: "/work/test/workflow.yaml",
      manifest,
      files: [],
      runtimeResources: [],
      packageHash: "package",
      executionHash: "execution",
    } as WorkflowPackage,
    manifest,
    workflowTimeoutMs: 5_000,
    inputValidator: schemas.compile({ type: "object" }),
    permissions: noPermissions,
    maximumAttempts: types.length * (retryAttempts + 1),
    maximumModelCalls: 0,
    steps: types.map((type, ordinal) => ({
      id: `step-${ordinal + 1}`,
      uses: `${type.name}@${type.version}`,
      ordinal,
      type,
      with:
        ordinal === 0
          ? { value: "$inputs.value" }
          : { value: `$steps.step-${ordinal}.output.value` },
      timeoutMs: 1_000,
      retry: {
        attempts: retryAttempts,
        backoff: { initialMs: 1, multiplier: 1, maximumMs: 1 },
        when: ["connection_error"],
      },
      allowUntrustedInput: false,
      inputValidator: schemas.compile(type.inputSchema),
      outputValidator: schemas.compile(type.outputSchema),
    })),
    outputs: [
      {
        name: "result",
        value: `$steps.step-${types.length}.output.value`,
        schema: { type: "number" },
        validator: schemas.compile({ type: "number" }),
      },
    ],
  };
}

function fakeStep(execute: (input: number) => Promise<number>): WorkflowStepType {
  return {
    name: "fake",
    version: 1,
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: { value: { type: "number" } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["value"],
      properties: { value: { type: "number" } },
      additionalProperties: false,
    },
    classify: () => ({
      effect: "read-only",
      permissions: noPermissions,
      retryable: ["connection_error"],
    }),
    preview: () => "fake",
    async execute(input) {
      const value = (input.value as { value: number }).value;
      return resolved({ value: await execute(value) }, input.provenance);
    },
  };
}

function createRun(store: WorkflowRunStore, workflowPlan: WorkflowExecutionPlan): string {
  return store.createRun({
    id: "run",
    workflowName: "test",
    revision: 1,
    packageHash: "package",
    executionHash: "execution",
    workspace: "/work",
    inputs: resolved({ value: 1 }, { untrusted: true }),
    steps: workflowPlan.steps.map((step) => ({
      id: step.id,
      ordinal: step.ordinal,
      uses: step.uses,
      effect: "read-only",
    })),
  }).id;
}

describe("executeWorkflow", () => {
  test("runs steps in order, validates outputs, and journals success despite event failure", async () => {
    const calls: number[] = [];
    const workflowPlan = plan([
      fakeStep(async (value) => {
        calls.push(value);
        return value + 1;
      }),
      fakeStep(async (value) => {
        calls.push(value);
        return value + 1;
      }),
    ]);
    const store = new WorkflowRunStore(":memory:");
    const runId = createRun(store, workflowPlan);
    const output = await executeWorkflow({
      plan: workflowPlan,
      runId,
      workspace: "/work",
      startedAt: new Date(0).toISOString(),
      inputs: resolved({ value: 1 }, { untrusted: true }),
      secrets: {},
      approvedPermissions: noPermissions,
      store,
      events: {
        emit() {
          throw new Error("event failure");
        },
      },
    });
    expect(calls).toEqual([1, 2]);
    expect(output.value).toEqual({ result: 3 });
    expect(store.getRun(runId)?.status).toBe("succeeded");
    store.close();
  });

  test("retries declared transient errors then succeeds", async () => {
    let calls = 0;
    const workflowPlan = plan(
      [
        fakeStep(async (value) => {
          calls++;
          if (calls === 1) throw new WorkflowStepError("temporary", "connection_error", true);
          return value;
        }),
      ],
      1,
    );
    const store = new WorkflowRunStore(":memory:");
    const runId = createRun(store, workflowPlan);
    await executeWorkflow({
      plan: workflowPlan,
      runId,
      workspace: "/work",
      startedAt: new Date(0).toISOString(),
      inputs: resolved({ value: 1 }),
      secrets: {},
      approvedPermissions: noPermissions,
      store,
    });
    expect(calls).toBe(2);
    expect(store.steps(runId)[0]?.attempts).toBe(2);
    store.close();
  });

  test("journals a step deadline as timeout rather than cancellation", async () => {
    const waitingStep: WorkflowStepType = {
      ...fakeStep(async (value) => value),
      async execute(_input, context) {
        return await new Promise((_, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    };
    const workflowPlan = plan([waitingStep]);
    workflowPlan.steps[0]!.timeoutMs = 10;
    const store = new WorkflowRunStore(":memory:");
    const runId = createRun(store, workflowPlan);

    await expect(
      executeWorkflow({
        plan: workflowPlan,
        runId,
        workspace: "/work",
        startedAt: new Date(0).toISOString(),
        inputs: resolved({ value: 1 }),
        secrets: {},
        approvedPermissions: noPermissions,
        store,
      }),
    ).rejects.toThrow("workflow step 'step-1' timed out after 10ms");

    expect(store.getRun(runId)).toMatchObject({
      status: "failed",
      error: { code: "timeout", message: "workflow step 'step-1' timed out after 10ms" },
    });
    expect(store.steps(runId)[0]).toMatchObject({
      status: "failed",
      error: { code: "timeout" },
    });
    store.close();
  });

  test("fails fast and leaves later steps pending", async () => {
    const second: JsonValue[] = [];
    const workflowPlan = plan([
      fakeStep(async () => {
        throw new Error("boom");
      }),
      fakeStep(async (value) => {
        second.push(value);
        return value;
      }),
    ]);
    const store = new WorkflowRunStore(":memory:");
    const runId = createRun(store, workflowPlan);
    await expect(
      executeWorkflow({
        plan: workflowPlan,
        runId,
        workspace: "/work",
        startedAt: new Date(0).toISOString(),
        inputs: resolved({ value: 1 }),
        secrets: {},
        approvedPermissions: noPermissions,
        store,
      }),
    ).rejects.toThrow("boom");
    expect(second).toEqual([]);
    expect(store.steps(runId).map((step) => step.status)).toEqual(["failed", "pending"]);
    store.close();
  });

  test("requires authorization before starting the first step", async () => {
    const workflowPlan = plan([fakeStep(async (value) => value)]);
    workflowPlan.permissions = {
      ...noPermissions,
      network: [{ host: "api.example.com", methods: ["GET"] }],
    };
    const store = new WorkflowRunStore(":memory:");
    const runId = createRun(store, workflowPlan);
    await expect(
      executeWorkflow({
        plan: workflowPlan,
        runId,
        workspace: "/work",
        startedAt: new Date(0).toISOString(),
        inputs: resolved({ value: 1 }),
        secrets: {},
        approvedPermissions: noPermissions,
        store,
      }),
    ).rejects.toThrow("does not cover");
    expect(store.steps(runId)[0]?.attempts).toBe(0);
    store.close();
  });
});
