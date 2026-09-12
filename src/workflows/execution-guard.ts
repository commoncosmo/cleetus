import type { WorkflowDraftRecord } from "./creator/types";
import type { WorkflowPackage } from "./package";

export interface WorkflowExecutionConflict {
  kind: "replacement_draft";
  draftId: string;
  workflow: string;
  scope: "project" | "global";
  activeRevision: number;
  pendingRevision: number;
}

export interface WorkflowExecutionGuard {
  conflict(pkg: WorkflowPackage): WorkflowExecutionConflict | undefined;
}

export interface WorkflowDraftReader {
  list(): WorkflowDraftRecord[];
}

function pendingRevision(draft: WorkflowDraftRecord): number | undefined {
  return draft.targetRevision ?? draft.output?.manifest?.revision;
}

export function isValidReplacementDraft(draft: WorkflowDraftRecord, pkg: WorkflowPackage): boolean {
  const revision = pendingRevision(draft);
  return (
    draft.name === pkg.name &&
    draft.scope === pkg.source &&
    draft.phase === "draft" &&
    draft.diagnostics.length === 0 &&
    draft.output?.phase === "draft" &&
    draft.output.manifest?.name === pkg.name &&
    revision !== undefined &&
    revision > pkg.manifest.revision
  );
}

export class WorkflowDraftExecutionGuard implements WorkflowExecutionGuard {
  constructor(private readonly drafts: WorkflowDraftReader) {}

  conflict(pkg: WorkflowPackage): WorkflowExecutionConflict | undefined {
    const draft = this.drafts.list().find((candidate) => isValidReplacementDraft(candidate, pkg));
    if (!draft) return undefined;
    return {
      kind: "replacement_draft",
      draftId: draft.id,
      workflow: pkg.name,
      scope: draft.scope,
      activeRevision: pkg.manifest.revision,
      pendingRevision: pendingRevision(draft)!,
    };
  }
}

export function formatWorkflowExecutionConflict(conflict: WorkflowExecutionConflict): string {
  return [
    `workflow '${conflict.workflow}' has valid replacement revision ${conflict.pendingRevision} awaiting activation`,
    `active revision ${conflict.activeRevision} was not run`,
    "review the draft with '/workflow review', then activate and replace it, or cancel the draft",
  ].join("; ");
}
