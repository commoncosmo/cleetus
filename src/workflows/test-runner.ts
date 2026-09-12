import { executeWorkflow } from "./executor";
import { applyWorkflowInputDefaults } from "./input-defaults";
import { WorkflowRunStore } from "./journal";
import type { WorkflowPackage } from "./package";
import { resolved } from "./provenance";
import { WorkflowStepError } from "./retry";
import type { WorkflowStepRegistry, WorkflowStepType } from "./step-registry";
import type { WorkflowTestCase } from "./test-case";
import type { JsonObject, JsonValue } from "./types";
import { validateWorkflowPackage } from "./validate";

const EXTERNAL = new Set(["http.request", "llm.generate", "command.run"]);

export interface WorkflowTestResult {
  name: string;
  passed: boolean;
  failures: string[];
  outputs?: JsonObject;
}

function boundedJson(value: JsonValue | JsonObject | undefined, maximum = 1_000): string {
  const encoded = value === undefined ? "undefined" : JSON.stringify(value);
  return encoded.length <= maximum ? encoded : `${encoded.slice(0, maximum)}…`;
}

function stepErrorMessage(error: JsonValue | undefined): string | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}

export async function runWorkflowTestCase(
  pkg: WorkflowPackage,
  registry: WorkflowStepRegistry,
  testCase: WorkflowTestCase,
  options: { includeOutputs?: boolean } = {},
): Promise<WorkflowTestResult> {
  const validation = validateWorkflowPackage(pkg, registry);
  if (!validation.plan) {
    return {
      name: testCase.name,
      passed: false,
      failures: validation.issues.map((issue) => `${issue.path}: ${issue.message}`),
    };
  }
  const plan = validation.plan;
  const failures: string[] = [];
  const preparedInputs = applyWorkflowInputDefaults(plan.manifest.inputs, testCase.inputs);
  const inputIssues = plan.inputValidator.validate(preparedInputs);
  if (inputIssues.length > 0) {
    return {
      name: testCase.name,
      passed: false,
      failures: inputIssues.map(
        (issue) =>
          `test inputs failed workflow schema validation at ${issue.path}: ${issue.message}`,
      ),
    };
  }
  plan.steps = plan.steps.map((step) => {
    if (!EXTERNAL.has(step.type.name)) return step;
    const mock = testCase.mocks[step.id];
    if (!mock) {
      failures.push(`external step '${step.id}' has no declared mock`);
      return step;
    }
    const type: WorkflowStepType = {
      ...step.type,
      async execute() {
        if (mock.error) {
          throw new WorkflowStepError(mock.error.message, mock.error.class);
        }
        return resolved(mock.output as JsonValue, {
          untrusted: true,
          origins: [`test-mock:${step.id}`],
        });
      },
    };
    return { ...step, type };
  });
  if (failures.length) return { name: testCase.name, passed: false, failures };
  const store = new WorkflowRunStore(":memory:");
  const testSecrets = Object.fromEntries(
    Object.keys(plan.manifest.secrets ?? {}).map((name) => [
      name,
      resolved("offline-secret-placeholder", {
        sensitive: true,
        origins: [`test-secret:${name}`],
      }),
    ]),
  );
  const run = store.createRun({
    workflowName: pkg.name,
    revision: pkg.manifest.revision,
    packageHash: pkg.packageHash,
    executionHash: pkg.executionHash,
    workspace: pkg.dir,
    inputs: resolved(preparedInputs, { untrusted: true }),
    steps: plan.steps.map((step) => ({
      id: step.id,
      ordinal: step.ordinal,
      uses: step.uses,
      effect: step.type.classify(step.with).effect,
    })),
  });
  let outputs: JsonObject | undefined;
  try {
    outputs = (
      await executeWorkflow({
        plan,
        runId: run.id,
        workspace: pkg.dir,
        startedAt: new Date().toISOString(),
        inputs: resolved(preparedInputs, { untrusted: true }),
        secrets: testSecrets,
        approvedPermissions: plan.permissions,
        store,
      })
    ).value;
  } catch {
    // Expected failure assertions are evaluated from authoritative journal state below.
  }
  const record = store.getRun(run.id)!;
  const steps = store.steps(run.id);
  if (record.status !== testCase.expect.status) {
    failures.push(`expected status ${testCase.expect.status}, got ${record.status}`);
    const failedStep = steps.find((step) => step.status === "failed");
    const stepMessage = stepErrorMessage(failedStep?.error);
    const runMessage = stepErrorMessage(record.error);
    if (failedStep && stepMessage) {
      failures.push(`step '${failedStep.stepId}' failed: ${stepMessage}`);
    } else if (runMessage) {
      failures.push(`workflow failed outside a step attempt: ${runMessage}`);
    }
  }
  if (
    testCase.expect.outputs &&
    JSON.stringify(outputs) !== JSON.stringify(testCase.expect.outputs)
  ) {
    failures.push(
      `final outputs did not match: expected ${boundedJson(testCase.expect.outputs)}; received ${boundedJson(outputs)}`,
    );
  }
  if (
    testCase.expect.failed_step &&
    !steps.some((step) => step.stepId === testCase.expect.failed_step && step.status === "failed")
  ) {
    failures.push(`expected failed step '${testCase.expect.failed_step}'`);
  }
  for (const [stepId, attempts] of Object.entries(testCase.expect.attempts ?? {})) {
    const actual = steps.find((step) => step.stepId === stepId)?.attempts;
    if (actual !== attempts)
      failures.push(`expected ${stepId} attempts ${attempts}, got ${actual}`);
  }
  store.close();
  return {
    name: testCase.name,
    passed: failures.length === 0,
    failures,
    ...(options.includeOutputs ? { outputs } : {}),
  };
}
