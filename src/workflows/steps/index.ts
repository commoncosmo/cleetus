import type { Sandbox } from "../../sandbox/types";
import type { WorkflowRunStore } from "../journal";
import type { WorkflowModelCallService, WorkflowModelSelection } from "../model-call";
import { WorkflowSchemaService } from "../schema";
import { WorkflowStepRegistry } from "../step-registry";
import { createAssertSchemaStep } from "./assert-schema";
import { createCommandRunStep } from "./command-run";
import { dataSelectStep } from "./data-select";
import { type HttpRequestStepDependencies, createHttpRequestStep } from "./http-request";
import { createLlmGenerateStep } from "./llm-generate";
import { textTemplateStep } from "./text-template";

export interface DeterministicWorkflowStepDependencies {
  schemas?: WorkflowSchemaService;
}

/** Deterministic built-ins. External I/O steps are registered by the complete factory in Slice 2. */
export function createDeterministicWorkflowStepRegistry(
  dependencies: DeterministicWorkflowStepDependencies = {},
): WorkflowStepRegistry {
  const registry = new WorkflowStepRegistry();
  registry.register(dataSelectStep);
  registry.register(textTemplateStep);
  registry.register(createAssertSchemaStep(dependencies.schemas ?? new WorkflowSchemaService()));
  return registry;
}

export interface BuiltinWorkflowStepDependencies extends HttpRequestStepDependencies {
  schemas?: WorkflowSchemaService;
  sandbox: Sandbox;
  modelCalls: WorkflowModelCallService;
  packageDir: string;
  workflowModel?: Partial<WorkflowModelSelection>;
  runModel?: Partial<WorkflowModelSelection>;
  defaultModel?: Partial<WorkflowModelSelection>;
  journal?: Pick<WorkflowRunStore, "recordModelAttempt">;
  allowSensitiveInput?: (stepId: string, origins: string[]) => boolean;
}

export function createBuiltinWorkflowStepRegistry(
  dependencies: BuiltinWorkflowStepDependencies,
): WorkflowStepRegistry {
  const schemas = dependencies.schemas ?? new WorkflowSchemaService();
  const registry = createDeterministicWorkflowStepRegistry({ schemas });
  registry.register(createHttpRequestStep(dependencies));
  registry.register(
    createCommandRunStep({
      sandbox: dependencies.sandbox,
      packageDir: dependencies.packageDir,
    }),
  );
  registry.register(
    createLlmGenerateStep({
      calls: dependencies.modelCalls,
      schemas,
      packageDir: dependencies.packageDir,
      workflowModel: dependencies.workflowModel,
      runModel: dependencies.runModel,
      defaultModel: dependencies.defaultModel,
      journal: dependencies.journal,
      allowSensitiveInput: dependencies.allowSensitiveInput,
    }),
  );
  return registry;
}
