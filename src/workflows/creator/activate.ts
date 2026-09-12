import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { expectedWorkflowAdapter, loadWorkflowPackage } from "../package";
import type { WorkflowRegistry } from "../registry";
import type { WorkflowStepRegistry } from "../step-registry";
import { validateWorkflowPackage } from "../validate";
import type { WorkflowRevisionBase } from "./types";

export function activateWorkflowDraft(input: {
  draftPackageDir: string;
  activeRoot: string;
  scope: "project" | "global";
  steps: WorkflowStepRegistry | ((packageDir: string) => WorkflowStepRegistry);
  registry?: WorkflowRegistry;
  replace?: boolean;
  expectedBase?: WorkflowRevisionBase;
}): { activeDir: string; backupDir?: string } {
  let pkg = loadWorkflowPackage(input.draftPackageDir, input.scope);
  const activeDir = join(input.activeRoot, pkg.name);
  if (existsSync(activeDir) && !input.replace) {
    throw new Error(
      `workflow '${pkg.name}' already exists; replacement requires explicit approval`,
    );
  }
  const previous = existsSync(activeDir) ? loadWorkflowPackage(activeDir, input.scope) : undefined;
  if (input.replace && input.expectedBase) {
    if (
      !previous ||
      previous.source !== input.expectedBase.scope ||
      previous.manifest.revision !== input.expectedBase.revision ||
      previous.packageHash !== input.expectedBase.packageHash
    ) {
      throw new Error(
        `workflow '${pkg.name}' changed after this revision draft began; reopen the revision against the current active package`,
      );
    }
  }
  const previousRevision = previous?.manifest.revision;
  const expectedRevision = previousRevision === undefined ? 1 : previousRevision + 1;
  if (pkg.manifest.revision !== expectedRevision) {
    writeFileSync(
      join(input.draftPackageDir, "workflow.yaml"),
      stringify({ ...pkg.manifest, revision: expectedRevision }),
    );
    pkg = loadWorkflowPackage(input.draftPackageDir, input.scope);
  }
  const steps =
    typeof input.steps === "function" ? input.steps(input.draftPackageDir) : input.steps;
  const validation = validateWorkflowPackage(pkg, steps);
  if (!validation.plan) {
    throw new Error(
      `workflow draft is invalid: ${validation.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  mkdirSync(input.activeRoot, { recursive: true });
  const staging = join(input.activeRoot, `.${pkg.name}.activate-${process.pid}-${Date.now()}`);
  cpSync(input.draftPackageDir, staging, { recursive: true, dereference: false });
  writeFileSync(join(staging, "SKILL.md"), expectedWorkflowAdapter(pkg));
  let backupDir: string | undefined;
  try {
    if (existsSync(activeDir)) {
      const backupRoot = join(input.activeRoot, ".revisions", pkg.name);
      mkdirSync(backupRoot, { recursive: true });
      backupDir = join(backupRoot, `${previousRevision ?? 0}-${Date.now()}`);
      renameSync(activeDir, backupDir);
    }
    renameSync(staging, activeDir);
  } catch (error) {
    if (backupDir && existsSync(backupDir) && !existsSync(activeDir)) {
      renameSync(backupDir, activeDir);
      backupDir = undefined;
    }
    if (existsSync(staging)) rmSync(staging, { recursive: true });
    throw error;
  }
  input.registry?.refresh();
  return { activeDir, backupDir };
}
