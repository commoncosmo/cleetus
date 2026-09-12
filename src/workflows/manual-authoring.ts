import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { activateWorkflowDraft } from "./creator/activate";
import { buildWorkflowSemanticDiff, deriveLegacyWorkflowChangeSet } from "./creator/revision-diff";
import type {
  WorkflowCreatorResource,
  WorkflowRevisionBase,
  WorkflowSemanticDiff,
} from "./creator/types";
import { type WorkflowPackage, loadWorkflowPackage } from "./package";
import type { WorkflowRegistry } from "./registry";
import { testWorkflowPackage } from "./service";
import type { WorkflowStepRegistry } from "./step-registry";
import type { WorkflowTestResult } from "./test-runner";
import type { WorkflowSource } from "./types";
import { type ValidateWorkflowResult, validateWorkflowPackage } from "./validate";

const WORKFLOW_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface ManualWorkflowDraftRecord {
  schema_version: 1;
  name: string;
  scope: WorkflowSource;
  base: {
    revision: number;
    package_hash: string;
    execution_hash: string;
  };
  created_at: string;
}

export interface ManualWorkflowDraft {
  record: ManualWorkflowDraftRecord;
  dir: string;
  packageDir: string;
}

export interface ManualWorkflowReview {
  draft: ManualWorkflowDraft;
  base: WorkflowPackage;
  candidate: WorkflowPackage;
  targetRevision: number;
  stale: boolean;
  validation: ValidateWorkflowResult;
  tests: WorkflowTestResult[];
  semanticDiff: WorkflowSemanticDiff;
  changed: boolean;
}

export function staleManualWorkflowGuidance(name: string): string {
  return [
    `the active workflow '${name}' changed outside this draft after the manual revision began, so publishing is blocked`,
    `cleetus workflow discard ${name} removes only the isolated draft; it does not undo changes to the active package`,
    "to keep the active changes, discard this draft and begin another revision; to undo them, restore the active package from source control or another known-good copy",
  ].join("\n");
}

function requireName(name: string): void {
  if (!WORKFLOW_NAME.test(name)) {
    throw new Error(
      "workflow name must use lowercase letters and numbers separated by single hyphens",
    );
  }
}

function draftDir(root: string, name: string): string {
  return join(root, ".manual-drafts", name);
}

function recordPath(root: string, name: string): string {
  return join(draftDir(root, name), "draft.json");
}

function packageDir(root: string, name: string): string {
  return join(draftDir(root, name), "package", name);
}

function parseRecord(value: unknown, path: string): ManualWorkflowDraftRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`manual workflow draft metadata is invalid: ${path}`);
  }
  const record = value as Partial<ManualWorkflowDraftRecord>;
  if (
    record.schema_version !== 1 ||
    typeof record.name !== "string" ||
    (record.scope !== "project" && record.scope !== "global") ||
    !record.base ||
    typeof record.base.revision !== "number" ||
    typeof record.base.package_hash !== "string" ||
    typeof record.base.execution_hash !== "string" ||
    typeof record.created_at !== "string"
  ) {
    throw new Error(`manual workflow draft metadata is invalid: ${path}`);
  }
  return record as ManualWorkflowDraftRecord;
}

function resources(pkg: WorkflowPackage): WorkflowCreatorResource[] {
  return pkg.files
    .filter((file) => file.path !== "workflow.yaml" && file.path !== "SKILL.md")
    .map((file) => ({ path: file.path, content: file.content }));
}

function revisionBase(pkg: WorkflowPackage): WorkflowRevisionBase {
  return {
    name: pkg.name,
    scope: pkg.source,
    revision: pkg.manifest.revision,
    packageHash: pkg.packageHash,
    executionHash: pkg.executionHash,
    manifest: pkg.manifest,
    resources: resources(pkg),
  };
}

export function beginManualWorkflowRevision(input: {
  active: WorkflowPackage;
  root: string;
  now?: Date;
}): ManualWorkflowDraft {
  requireName(input.active.name);
  const target = draftDir(input.root, input.active.name);
  if (existsSync(target)) {
    throw new Error(
      `manual draft already exists for workflow '${input.active.name}'; review, publish, or discard it first`,
    );
  }
  const staging = join(
    input.root,
    ".manual-drafts",
    `.${input.active.name}.revise-${process.pid}-${Date.now()}`,
  );
  const stagedPackage = join(staging, "package", input.active.name);
  const record: ManualWorkflowDraftRecord = {
    schema_version: 1,
    name: input.active.name,
    scope: input.active.source,
    base: {
      revision: input.active.manifest.revision,
      package_hash: input.active.packageHash,
      execution_hash: input.active.executionHash,
    },
    created_at: (input.now ?? new Date()).toISOString(),
  };
  try {
    mkdirSync(dirname(stagedPackage), { recursive: true });
    cpSync(input.active.dir, stagedPackage, { recursive: true, dereference: false });
    writeFileSync(join(staging, "draft.json"), `${JSON.stringify(record, null, 2)}\n`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { record, dir: target, packageDir: packageDir(input.root, input.active.name) };
}

export function loadManualWorkflowDraft(input: {
  root: string;
  name: string;
  scope: WorkflowSource;
}): ManualWorkflowDraft {
  requireName(input.name);
  const path = recordPath(input.root, input.name);
  if (!existsSync(path)) {
    throw new Error(`no ${input.scope} manual draft exists for workflow '${input.name}'`);
  }
  const record = parseRecord(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
  if (record.name !== input.name || record.scope !== input.scope) {
    throw new Error(`manual workflow draft metadata does not match '${input.name}'`);
  }
  const pkgDir = packageDir(input.root, input.name);
  if (!existsSync(pkgDir)) {
    throw new Error(`manual workflow draft package is missing: ${pkgDir}`);
  }
  return { record, dir: draftDir(input.root, input.name), packageDir: pkgDir };
}

export function discardManualWorkflowDraft(input: {
  root: string;
  name: string;
  scope: WorkflowSource;
}): void {
  const draft = loadManualWorkflowDraft(input);
  rmSync(draft.dir, { recursive: true });
}

export async function reviewManualWorkflowDraft(input: {
  root: string;
  name: string;
  scope: WorkflowSource;
  steps(pkg: WorkflowPackage): WorkflowStepRegistry;
}): Promise<ManualWorkflowReview> {
  const draft = loadManualWorkflowDraft(input);
  const activeDir = join(input.root, input.name);
  if (!existsSync(activeDir)) {
    throw new Error(`active ${input.scope} workflow '${input.name}' no longer exists`);
  }
  const base = loadWorkflowPackage(activeDir, input.scope);
  const candidate = loadWorkflowPackage(draft.packageDir, input.scope);
  const stale =
    base.manifest.revision !== draft.record.base.revision ||
    base.packageHash !== draft.record.base.package_hash ||
    base.executionHash !== draft.record.base.execution_hash;
  const validation = validateWorkflowPackage(candidate, input.steps(candidate));
  const tests = validation.plan ? await testWorkflowPackage(candidate, input.steps(candidate)) : [];
  const baseRevision = revisionBase(base);
  const targetRevision = base.manifest.revision + 1;
  const applied = {
    manifest: { ...candidate.manifest, revision: targetRevision },
    resources: resources(candidate),
  };
  const changeSet = deriveLegacyWorkflowChangeSet(baseRevision, applied);
  const semanticDiff = buildWorkflowSemanticDiff(baseRevision, changeSet, applied);
  return {
    draft,
    base,
    candidate,
    targetRevision,
    stale,
    validation,
    tests,
    semanticDiff,
    changed: semanticDiff.changes.length > 0,
  };
}

export async function publishManualWorkflowDraft(input: {
  root: string;
  name: string;
  scope: WorkflowSource;
  steps(pkg: WorkflowPackage): WorkflowStepRegistry;
  registry?: WorkflowRegistry;
}): Promise<{ activeDir: string; backupDir?: string; revision: number }> {
  const review = await reviewManualWorkflowDraft(input);
  if (review.stale) {
    throw new Error(staleManualWorkflowGuidance(input.name));
  }
  if (!review.validation.plan) {
    throw new Error(
      `manual workflow draft is invalid: ${review.validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const failures = review.tests.filter((result) => !result.passed);
  if (failures.length > 0) {
    throw new Error(
      `manual workflow draft tests failed: ${failures
        .map((result) => `${result.name}: ${result.failures.join("; ")}`)
        .join("; ")}`,
    );
  }
  if (!review.changed) {
    throw new Error(`manual workflow draft for '${input.name}' contains no publishable changes`);
  }
  const expectedBase = revisionBase(review.base);
  const activated = activateWorkflowDraft({
    draftPackageDir: review.draft.packageDir,
    activeRoot: input.root,
    scope: input.scope,
    steps: (dir) => {
      const pkg = loadWorkflowPackage(dir, input.scope);
      return input.steps(pkg);
    },
    registry: input.registry,
    replace: true,
    expectedBase,
  });
  rmSync(review.draft.dir, { recursive: true });
  return { ...activated, revision: review.targetRevision };
}
