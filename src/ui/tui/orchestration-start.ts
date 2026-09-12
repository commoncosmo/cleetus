import type { OrchestrationAdmissionReport } from "../../agent/orchestration-admission";
import type {
  OrchestrationPlan,
  Orchestrator,
  RunArgs,
  StructureFailure,
} from "../../agent/orchestrator";

type StructureOnlyOrchestrator = Pick<Orchestrator, "noticeStructureFailure" | "structure"> &
  Partial<Pick<Orchestrator, "getLastStructureFailure">>;

export type OrchestrationStructureOutcome =
  | { kind: "ready"; plan: OrchestrationPlan }
  | { kind: "failed"; failure?: StructureFailure }
  | { kind: "cancelled" };

export type OrchestrationStartTransition = {
  preserveExecutionChoice: boolean;
  retry: boolean;
};

/** Keep the caller's execution checkpoint until a task list actually exists. */
export function orchestrationStartTransition(
  outcome: OrchestrationStructureOutcome["kind"],
): OrchestrationStartTransition {
  return {
    // A ready task list is still only a proposal. Commit the caller's checkpoint when the user
    // chooses workers or a single agent, not when structuring happens to return JSON.
    preserveExecutionChoice: true,
    retry: outcome === "failed",
  };
}

export function admissionRevisionPlan(
  prosePlan: string,
  report: OrchestrationAdmissionReport,
): string {
  const evidence = [...report.risks, ...report.reasons].map((item) => `- ${item}`).join("\n");
  return `${prosePlan}\n\nDECOMPOSITION REPAIR (execution routing only; this does not change product scope):\nThe previous task list was not approved. Produce one replacement task list that addresses this admission evidence:\n${evidence || "- task boundaries or acceptance evidence need improvement"}\nRemove redundant discovery already answered by this plan. If exactly one genuinely blocking read-only fact remains, make it a bounded first explore task whose finding is consumed by later tasks. Give every implementation leaf named file ownership and focused behavior-level acceptance. Do not add a repository-wide verification-only leaf.`;
}

export function structuringFailureRevisionPlan(
  prosePlan: string,
  failure: StructureFailure,
): string {
  return `${prosePlan}\n\nDECOMPOSITION REPAIR (execution routing only; this does not change product scope):\nThe previous structuring attempt failed after ${failure.attempts} model call(s). Its final issue was:\n- ${failure.reason}\nProduce one replacement task list. Remove runtime-owned full-suite, lint, typecheck, build, baseline, and final-smoke gates from leaves; the runtime runs them after implementation. Preserve focused behavioral tests and product requirements. Do not repeat the rejected task shape.`;
}

/**
 * Structure an explicitly requested orchestration without silently changing execution modes.
 * A null plan or structuring error stops here; it must never become a normal single-agent turn.
 */
export async function structureOrchestrationForApproval(
  orchestrator: StructureOnlyOrchestrator,
  args: RunArgs,
): Promise<OrchestrationStructureOutcome> {
  try {
    const plan = await orchestrator.structure(args);
    if (args.signal.aborted) return { kind: "cancelled" };
    if (!plan) {
      const failure = orchestrator.getLastStructureFailure?.();
      orchestrator.noticeStructureFailure();
      return { kind: "failed", ...(failure ? { failure } : {}) };
    }
    return { kind: "ready", plan };
  } catch {
    if (args.signal.aborted) return { kind: "cancelled" };
    const failure = orchestrator.getLastStructureFailure?.();
    orchestrator.noticeStructureFailure();
    return { kind: "failed", ...(failure ? { failure } : {}) };
  }
}
