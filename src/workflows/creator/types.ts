import type { WorkflowManifest } from "../parse";
import type { WorkflowTestCase } from "../test-case";
import type { JsonValue, WorkflowSource } from "../types";

export type WorkflowCreatorPhase = "questions" | "draft";
export type WorkflowDraftPhase =
  | WorkflowCreatorPhase
  | "generating"
  | "failed"
  | "cancelled"
  | "activated";

export interface WorkflowCreatorResource {
  path: string;
  content: string;
}

export type WorkflowCreatorMock =
  | {
      step: string;
      uses: "http.request@1";
      response: {
        status: number;
        content_type: string;
        final_url: string;
        body: JsonValue;
      };
    }
  | {
      step: string;
      uses: "llm.generate@1";
      value: JsonValue;
    }
  | {
      step: string;
      uses: "command.run@1";
      stdout: JsonValue;
      stderr?: string;
      exit_code?: number;
      survivors?: number[];
    }
  | {
      step: string;
      uses: "http.request@1" | "llm.generate@1" | "command.run@1";
      error: { message: string; class?: string };
    };

export type WorkflowCreatorTestCase = Omit<WorkflowTestCase, "mocks"> & {
  mocks: WorkflowCreatorMock[];
};

export interface WorkflowCreatorTest {
  path: string;
  case: WorkflowCreatorTestCase;
}

export interface WorkflowCreatorAuthoritySummary {
  derived: string[];
  explicit: string[];
}

export interface WorkflowRevisionBase {
  name: string;
  scope: WorkflowSource;
  revision: number;
  packageHash: string;
  executionHash: string;
  manifest: WorkflowManifest;
  resources: WorkflowCreatorResource[];
}

export type WorkflowStep = WorkflowManifest["steps"][number];
export type WorkflowSecret = NonNullable<WorkflowManifest["secrets"]>[string];
export type WorkflowPermissions = WorkflowManifest["permissions"];
export type WorkflowExecution = WorkflowManifest["execution"];
export type WorkflowOutput = WorkflowManifest["outputs"][string];
export type WorkflowPresentation = WorkflowManifest["presentation"];

interface WorkflowRevisionOperationBase {
  id: string;
  rationale: string;
}

export type WorkflowRevisionOperation =
  | (WorkflowRevisionOperationBase & { op: "set-description"; description: string })
  | (WorkflowRevisionOperationBase & {
      op: "set-inputs";
      inputs: WorkflowManifest["inputs"];
    })
  | (WorkflowRevisionOperationBase & {
      op: "upsert-secret";
      name: string;
      secret: WorkflowSecret;
    })
  | (WorkflowRevisionOperationBase & { op: "remove-secret"; name: string })
  | (WorkflowRevisionOperationBase & {
      op: "set-permissions";
      permissions: WorkflowPermissions;
    })
  | (WorkflowRevisionOperationBase & {
      op: "set-execution";
      execution: WorkflowExecution;
    })
  | (WorkflowRevisionOperationBase & {
      op: "upsert-step";
      step: WorkflowStep;
      placement?: WorkflowStepPlacement;
    })
  | (WorkflowRevisionOperationBase & { op: "remove-step"; stepId: string })
  | (WorkflowRevisionOperationBase & {
      op: "move-step";
      stepId: string;
      placement: WorkflowStepPlacement;
    })
  | (WorkflowRevisionOperationBase & {
      op: "upsert-output";
      name: string;
      output: WorkflowOutput;
    })
  | (WorkflowRevisionOperationBase & { op: "remove-output"; name: string })
  | (WorkflowRevisionOperationBase & {
      op: "set-presentation";
      presentation: WorkflowPresentation | null;
    })
  | (WorkflowRevisionOperationBase & {
      op: "put-resource";
      path: string;
      content: string;
    })
  | (WorkflowRevisionOperationBase & { op: "delete-resource"; path: string });

export type WorkflowStepPlacement =
  | { before: string }
  | { after: string }
  | { first: true }
  | { last: true };

export interface WorkflowRevisionChangeSet {
  schemaVersion: 1;
  base: Pick<WorkflowRevisionBase, "name" | "scope" | "revision" | "packageHash" | "executionHash">;
  summary: string;
  operations: WorkflowRevisionOperation[];
}

export type WorkflowSemanticChangeCategory =
  | "metadata"
  | "inputs"
  | "secrets"
  | "permissions"
  | "execution"
  | "steps"
  | "outputs"
  | "presentation"
  | "resources"
  | "tests"
  | "derived";

export interface WorkflowSemanticChange {
  id: string;
  category: WorkflowSemanticChangeCategory;
  path: string;
  before?: string;
  after?: string;
  operationId?: string;
}

export interface WorkflowSemanticDiff {
  targetRevision: number;
  changes: WorkflowSemanticChange[];
  authority: { added: string[]; removed: string[] };
  riskFlags: string[];
  operationCoverage: Array<{ operationId: string; changeIds: string[] }>;
  derivedChanges: WorkflowSemanticChange[];
  unattributedChanges: WorkflowSemanticChange[];
}

export type WorkflowRequirementValueType =
  | "unknown"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "any";

export interface WorkflowRequirementField {
  /**
   * A flattened path through the value. The reserved segment "[]" denotes an
   * array item, so options.[].advantages describes a nested field without
   * requiring a recursive creator response schema.
   */
  path: string[];
  type: WorkflowRequirementValueType;
  itemType: "none" | WorkflowRequirementValueType;
  required: boolean;
  description: string;
  certainty: "explicit" | "conventional" | "unknown";
  /** Exact user wording that establishes an explicit type; empty otherwise. */
  evidence: string;
}

export interface WorkflowRequirementsContract {
  phase: "questions" | "ready";
  response: string;
  purpose: string;
  desiredResult: string;
  inputFields: WorkflowRequirementField[];
  modelSteps: Array<{
    id: string;
    purpose: string;
    outputFields: WorkflowRequirementField[];
  }>;
  externalActions: Array<{
    kind: "http" | "command" | "model" | "filesystem";
    description: string;
  }>;
  secrets: Array<{ name: string; purpose: string }>;
  presentation: string;
  assumptions: string[];
  unresolvedQuestions: string[];
}

export interface WorkflowCreatorOutput {
  response: string;
  phase: WorkflowCreatorPhase;
  mode?: "create" | "revise";
  scope?: "project" | "global";
  summary?: string;
  changeSet?: WorkflowRevisionChangeSet;
  manifest?: WorkflowManifest;
  resources?: WorkflowCreatorResource[];
  tests?: WorkflowCreatorTest[];
  authority?: WorkflowCreatorAuthoritySummary;
  compilerNotes?: string[];
  /** Persisted host-side interview state; it is not part of a workflow package. */
  requirementsContract?: WorkflowRequirementsContract;
  assumptions: string[];
  unresolvedQuestions: string[];
}

export interface WorkflowDraftRecord {
  id: string;
  sessionId?: string;
  scope: "project" | "global";
  name?: string;
  targetRevision?: number;
  creationProtocol?: "legacy-full-package" | "blueprint-v1";
  revisionProtocol?: "legacy-full-package" | "change-set-v1";
  revisionBase?: WorkflowRevisionBase;
  baseManifest?: WorkflowManifest;
  baseResources?: WorkflowCreatorResource[];
  changeSet?: WorkflowRevisionChangeSet;
  semanticDiff?: WorkflowSemanticDiff;
  phase: WorkflowDraftPhase;
  createdAt: string;
  updatedAt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  requirementMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  requirementsContract?: WorkflowRequirementsContract;
  output?: WorkflowCreatorOutput;
  lastError?: string;
  attemptedResponses?: {
    initial: string;
    repair: string;
  };
  diagnostics: Array<{ path: string; message: string }>;
}
