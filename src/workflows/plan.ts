import type { WorkflowPackage } from "./package";
import type { WorkflowManifest } from "./parse";
import type { CompiledWorkflowSchema } from "./schema";
import type { WorkflowStepType } from "./step-registry";
import type { JsonSchema, JsonValue, WorkflowPermissions, WorkflowRetryPolicy } from "./types";

export interface PlannedWorkflowStep {
  id: string;
  uses: string;
  ordinal: number;
  type: WorkflowStepType;
  with: JsonValue;
  timeoutMs: number;
  retry: WorkflowRetryPolicy;
  allowUntrustedInput: boolean;
  inputValidator: CompiledWorkflowSchema;
  outputValidator: CompiledWorkflowSchema;
}

export interface PlannedWorkflowOutput {
  name: string;
  value: JsonValue;
  schema: JsonSchema;
  validator: CompiledWorkflowSchema;
}

export interface WorkflowExecutionPlan {
  package: WorkflowPackage;
  manifest: WorkflowManifest;
  workflowTimeoutMs: number;
  inputValidator: CompiledWorkflowSchema;
  steps: PlannedWorkflowStep[];
  outputs: PlannedWorkflowOutput[];
  permissions: WorkflowPermissions;
  maximumAttempts: number;
  maximumModelCalls: number;
}
