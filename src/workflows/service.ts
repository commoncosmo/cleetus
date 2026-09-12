import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type WorkflowDryRun, buildWorkflowDryRun } from "./dry-run";
import { type WorkflowEventSink, emitWorkflowEvent } from "./events";
import {
  type WorkflowExecutionConflict,
  type WorkflowExecutionGuard,
  formatWorkflowExecutionConflict,
} from "./execution-guard";
import { executeWorkflow } from "./executor";
import { applyWorkflowInputDefaults } from "./input-defaults";
import type {
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowStepRecord,
} from "./journal";
import { type WorkflowPackage, loadWorkflowPackage } from "./package";
import type { WorkflowExecutionPlan } from "./plan";
import { resolved } from "./provenance";
import { workflowReferencesIn } from "./references";
import type { WorkflowRegistry } from "./registry";
import { WorkflowSecretResolver } from "./secrets";
import type { WorkflowStepRegistry } from "./step-registry";
import { parseWorkflowTestCase } from "./test-case";
import { type WorkflowTestResult, runWorkflowTestCase } from "./test-runner";
import type { JsonObject, WorkflowEffect, WorkflowResultEnvelope } from "./types";
import { type ValidateWorkflowResult, validateWorkflowPackage } from "./validate";

export type WorkflowAuthorizationDecision = "allow_once" | "trust_revision" | "deny";

export class WorkflowServiceError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_package"
      | "invalid_input"
      | "missing_secret"
      | "missing_grant"
      | "replacement_pending"
      | "denied"
      | "failed"
      | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowServiceError";
  }
}

export interface WorkflowServiceDependencies {
  registry: WorkflowRegistry;
  stepRegistry(pkg: WorkflowPackage, store?: WorkflowRunStore): WorkflowStepRegistry;
  openStore(pkg?: WorkflowPackage): WorkflowRunStore;
  workspace: string;
  environment?: Record<string, string | undefined>;
  authorize?: (
    plan: WorkflowExecutionPlan,
    dryRun: WorkflowDryRun,
  ) => Promise<WorkflowAuthorizationDecision>;
  events?: WorkflowEventSink;
  executionGuard?: WorkflowExecutionGuard;
}

export { applyWorkflowInputDefaults };

export async function testWorkflowPackage(
  pkg: WorkflowPackage,
  registry: WorkflowStepRegistry,
): Promise<WorkflowTestResult[]> {
  const testsDir = join(pkg.dir, "tests");
  if (!existsSync(testsDir)) return [];
  const results: WorkflowTestResult[] = [];
  for (const filename of readdirSync(testsDir)
    .filter((value) => /\.(?:ya?ml|json)$/u.test(value))
    .sort()) {
    const testCase = parseWorkflowTestCase(
      readFileSync(join(testsDir, filename), "utf8"),
      filename,
    );
    results.push(await runWorkflowTestCase(pkg, registry, testCase));
  }
  return results;
}

function effectForStep(plan: WorkflowExecutionPlan, index: number): WorkflowEffect {
  const step = plan.steps[index]!;
  try {
    return step.type.classify(step.with).effect;
  } catch {
    return "side-effecting";
  }
}

function requiredSecretNames(plan: WorkflowExecutionPlan): string[] {
  const names = new Set<string>();
  for (const step of plan.steps) {
    for (const reference of workflowReferencesIn(step.with)) {
      if (reference.namespace === "secrets" && reference.path[0]) {
        names.add(reference.path[0]);
      }
    }
  }
  return [...names].sort();
}

export class WorkflowService {
  constructor(private readonly dependencies: WorkflowServiceDependencies) {}

  list() {
    this.dependencies.registry.refresh();
    return this.dependencies.registry.list();
  }

  show(name: string): WorkflowPackage {
    this.dependencies.registry.refresh();
    const pkg = this.dependencies.registry.get(name);
    if (!pkg) throw new WorkflowServiceError("not_found", `workflow '${name}' was not found`);
    return pkg;
  }

  showRevision(name: string, revision: number): WorkflowPackage | undefined {
    const active = this.show(name);
    if (active.manifest.revision === revision) return active;
    const revisionsRoot = join(dirname(active.dir), ".revisions", name);
    if (!existsSync(revisionsRoot)) return undefined;
    const prefix = `${revision}-`;
    const candidates = readdirSync(revisionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const candidate of candidates) {
      try {
        const pkg = loadWorkflowPackage(join(revisionsRoot, candidate), active.source, {
          archived: true,
        });
        if (pkg.name === name && pkg.manifest.revision === revision) return pkg;
      } catch {
        // A damaged archived revision must not prevent a newer valid one from being found.
      }
    }
    return undefined;
  }

  executionConflict(name: string): WorkflowExecutionConflict | undefined {
    const pkg = this.show(name);
    return this.dependencies.executionGuard?.conflict(pkg);
  }

  assertRunnable(name: string): void {
    const conflict = this.executionConflict(name);
    if (conflict) {
      throw new WorkflowServiceError(
        "replacement_pending",
        formatWorkflowExecutionConflict(conflict),
      );
    }
  }

  validate(name: string): ValidateWorkflowResult {
    const pkg = this.show(name);
    return validateWorkflowPackage(pkg, this.dependencies.stepRegistry(pkg));
  }

  async test(name: string): Promise<WorkflowTestResult[]> {
    const pkg = this.show(name);
    return testWorkflowPackage(pkg, this.dependencies.stepRegistry(pkg));
  }

  private requirePlan(name: string): WorkflowExecutionPlan {
    const result = this.validate(name);
    if (!result.plan) {
      throw new WorkflowServiceError(
        "invalid_package",
        result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      );
    }
    return result.plan;
  }

  private validatedInputs(plan: WorkflowExecutionPlan, supplied: JsonObject): JsonObject {
    const inputs = applyWorkflowInputDefaults(plan.manifest.inputs, supplied);
    const inputIssues = plan.inputValidator.validate(inputs);
    if (inputIssues.length) {
      throw new WorkflowServiceError(
        "invalid_input",
        inputIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      );
    }
    return inputs;
  }

  dryRun(name: string, supplied: JsonObject = {}): WorkflowDryRun {
    const plan = this.requirePlan(name);
    return buildWorkflowDryRun(plan, this.validatedInputs(plan, supplied));
  }

  history(input: {
    workflowName?: string;
    limit?: number;
    offset?: number;
  }): WorkflowRunRecord[] {
    const store = this.dependencies.openStore(
      input.workflowName ? this.show(input.workflowName) : undefined,
    );
    try {
      return store.history({
        workflowName: input.workflowName,
        limit: input.limit ?? 20,
        offset: input.offset ?? 0,
      });
    } finally {
      store.close();
    }
  }

  runSteps(workflowName: string, runId: string): WorkflowStepRecord[] {
    const pkg = this.show(workflowName);
    const store = this.dependencies.openStore(pkg);
    try {
      const run = store.getRun(runId);
      if (!run || run.workflowName !== workflowName) return [];
      return store.steps(runId);
    } finally {
      store.close();
    }
  }

  runDetail(workflowName: string, runId: string): WorkflowRunDetail {
    const pkg = this.show(workflowName);
    const store = this.dependencies.openStore(pkg);
    try {
      const run = store.getRun(runId);
      if (!run || run.workflowName !== workflowName) {
        throw new WorkflowServiceError(
          "not_found",
          `workflow run '${runId}' was not found for '${workflowName}'`,
        );
      }
      return {
        run,
        steps: store.steps(runId),
        attempts: store.attempts(runId),
        modelAttempts: store.modelAttempts(runId),
      };
    } finally {
      store.close();
    }
  }

  async run(input: {
    name: string;
    inputs: JsonObject;
    signal?: AbortSignal;
  }): Promise<WorkflowResultEnvelope> {
    const pkg = this.show(input.name);
    const conflict = this.dependencies.executionGuard?.conflict(pkg);
    if (conflict) {
      throw new WorkflowServiceError(
        "replacement_pending",
        formatWorkflowExecutionConflict(conflict),
      );
    }
    const store = this.dependencies.openStore(pkg);
    try {
      const validation = validateWorkflowPackage(pkg, this.dependencies.stepRegistry(pkg, store));
      if (!validation.plan) {
        throw new WorkflowServiceError(
          "invalid_package",
          validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
        );
      }
      const plan = validation.plan;
      const inputs = this.validatedInputs(plan, input.inputs);
      const secrets = new WorkflowSecretResolver(
        plan.manifest.secrets ?? {},
        this.dependencies.environment,
      );
      const requiredSecrets = requiredSecretNames(plan);
      const availability = secrets.availability(requiredSecrets);
      if (availability.missing.length) {
        throw new WorkflowServiceError(
          "missing_secret",
          `missing workflow secrets: ${availability.missing.join(", ")}`,
        );
      }
      const dryRun = buildWorkflowDryRun(plan, inputs);
      await emitWorkflowEvent(this.dependencies.events, {
        type: "run_status",
        workflow: pkg.name,
        revision: pkg.manifest.revision,
        totalSteps: plan.steps.length,
        status: "preparing",
      });
      if (!this.dependencies.authorize) {
        await emitWorkflowEvent(this.dependencies.events, {
          type: "run_status",
          workflow: pkg.name,
          revision: pkg.manifest.revision,
          totalSteps: plan.steps.length,
          status: "failed",
        });
        throw new WorkflowServiceError(
          "missing_grant",
          "workflow execution requires an exact-revision authorization",
        );
      }
      await emitWorkflowEvent(this.dependencies.events, {
        type: "run_status",
        workflow: pkg.name,
        revision: pkg.manifest.revision,
        totalSteps: plan.steps.length,
        status: "awaiting_permission",
      });
      const decision = await this.dependencies.authorize(plan, dryRun);
      if (decision === "deny") {
        await emitWorkflowEvent(this.dependencies.events, {
          type: "run_status",
          workflow: pkg.name,
          revision: pkg.manifest.revision,
          totalSteps: plan.steps.length,
          status: "failed",
        });
        throw new WorkflowServiceError("denied", "workflow execution was denied");
      }
      const secretValues = Object.fromEntries(
        requiredSecrets.map((name) => [name, secrets.resolve(name)]),
      );
      const startedAt = new Date().toISOString();
      const run = store.createRun({
        workflowName: pkg.name,
        revision: pkg.manifest.revision,
        packageHash: pkg.packageHash,
        executionHash: pkg.executionHash,
        workspace: this.dependencies.workspace,
        inputs: resolved(inputs, { untrusted: true, origins: ["workflow:inputs"] }),
        steps: plan.steps.map((step, index) => ({
          id: step.id,
          ordinal: step.ordinal,
          uses: step.uses,
          effect: effectForStep(plan, index),
        })),
      });
      try {
        const outputs = await executeWorkflow({
          plan,
          runId: run.id,
          workspace: this.dependencies.workspace,
          startedAt,
          inputs: resolved(inputs, { untrusted: true, origins: ["workflow:inputs"] }),
          secrets: secretValues,
          approvedPermissions: plan.permissions,
          store,
          signal: input.signal,
          events: this.dependencies.events,
        });
        return {
          run_id: run.id,
          workflow: pkg.name,
          revision: pkg.manifest.revision,
          execution_hash: pkg.executionHash,
          status: "succeeded",
          outputs: outputs.value,
        };
      } catch (error) {
        const record = store.getRun(run.id)!;
        return {
          run_id: run.id,
          workflow: pkg.name,
          revision: pkg.manifest.revision,
          execution_hash: pkg.executionHash,
          status: record.status,
          error: {
            code: record.status === "cancelled" ? "cancelled" : "failed",
            message: (error as Error).message,
          },
        };
      }
    } finally {
      store.close();
    }
  }
}
