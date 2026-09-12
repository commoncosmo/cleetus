import type { RawOrchestration } from "./schema";

/** Resolved orchestrated-plan-execution settings. */
export interface OrchestrationConfig {
  /** Master gate. Off by default — opt-in like plan_or_go. */
  enabled: boolean;
  /** Model for plan structuring / replan / closing. "" → the active session model. */
  orchestratorModel: string;
  /** Model for worker subagents. "" → the active session model. */
  workerModel: string;
  /** Provider for the orchestrator model. "" → the active session provider. */
  orchestratorProvider: string;
  /** Provider for worker subagents. "" → the active session provider. */
  workerProvider: string;
  /** Cap on plan length (structuring + replan both clamp to this). */
  maxTasks: number;
  /** Global ceiling on orchestrator replan calls. Pending approved work may continue afterward. */
  maxReplans: number;
  /** Harness-level retries on a THROWN worker error before marking a task failed. */
  maxTaskRetries: number;
  /** Maximum orchestrator executions of one normalized logical task (original + Retry variants).
   *  Prevents a preserved integration task from surviving every replan indefinitely. */
  maxTaskAttempts: number;
  /** Objective-relative scope budget multiplier for replans (see clampScope). 1 = no growth. */
  maxScopeGrowth: number;
  /** Per-worker-turn cumulative token-spend ceiling (input + output across all model calls in
   *  the turn). On breach the worker stops with a `token_budget` reason so the orchestrator can
   *  replan. `0` = unlimited. Interactive turns are unaffected. */
  workerTurnTokens: number;
  /** Additional billed tokens granted once when a worker reaches the soft cost ceiling after
   *  making durable progress. Zero disables progress extension. */
  workerProgressExtensionTokens: number;
  /** Absolute billed-token backstop as a multiplier of workerTurnTokens. */
  workerMaxTokenMultiplier: number;
  /** Per-worker-turn early-stop: stop when this many tokens accrue since the last landed edit —
   *  distinct from `workerTurnTokens`, the flat total-spend ceiling. Catches pure re-read/re-search
   *  thrash (zero edits landed) well before the flat budget trips. Workers-only; `0` = disabled. */
  workerNoProgressTokens: number;
  /** Per-worker-turn wall-clock ceiling (ms). A worker turn exceeding it is aborted (mid-tool
   *  as well as mid-stream) and reported as `time_budget`. Workers-only; 0 = unlimited. */
  workerTurnMs: number;
  /** Consecutive failing runs of ONE command, inside a worker, that abort the worker turn with a
   *  `thrash` reason (→ replan). Workers-only; `0` disables (relies on the token/time ceilings). */
  workerThrashRepeats: number;
  /** Worker-only: when true, refuse a worker `write_file` that would clobber a file already on
   *  disk but untouched by this worker this turn (a previous task's file). Default true. */
  protectExistingFiles: boolean;
  /** Worker-only: when true, refuse a worker `write_file` that would create a BRAND-NEW file whose
   *  path matches a still-pending task's title (scope creep into a later task). Default true. */
  guardPendingScope: boolean;
  /** Retry a stopped worker once using the orchestrator model/provider. */
  recoveryEscalation: boolean;
  /** Run orchestrator-model semantic verification, one bounded repair, and post-fix rechecks. */
  finalIntegration: boolean;
}

export const DEFAULT_ORCHESTRATION: OrchestrationConfig = {
  enabled: false,
  orchestratorModel: "",
  workerModel: "",
  orchestratorProvider: "",
  workerProvider: "",
  maxTasks: 20,
  maxReplans: 40, // planner-call ceiling; > maxTasks to allow corrective replans
  maxTaskRetries: 1,
  maxTaskAttempts: 2,
  maxScopeGrowth: 2.0,
  workerTurnTokens: 400000,
  workerProgressExtensionTokens: 200000,
  workerMaxTokenMultiplier: 1.5,
  workerNoProgressTokens: 150000,
  workerTurnMs: 750000,
  workerThrashRepeats: 4,
  protectExistingFiles: true,
  guardPendingScope: true,
  recoveryEscalation: true,
  finalIntegration: true,
};

/** Resolve orchestration settings with project > global > default precedence. Pure. */
export function resolveOrchestration(
  global?: RawOrchestration,
  project?: RawOrchestration,
): OrchestrationConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? DEFAULT_ORCHESTRATION.enabled,
    orchestratorModel:
      project?.orchestrator_model ??
      global?.orchestrator_model ??
      DEFAULT_ORCHESTRATION.orchestratorModel,
    workerModel: project?.worker_model ?? global?.worker_model ?? DEFAULT_ORCHESTRATION.workerModel,
    orchestratorProvider:
      project?.orchestrator_provider ??
      global?.orchestrator_provider ??
      DEFAULT_ORCHESTRATION.orchestratorProvider,
    workerProvider:
      project?.worker_provider ?? global?.worker_provider ?? DEFAULT_ORCHESTRATION.workerProvider,
    maxTasks: project?.max_tasks ?? global?.max_tasks ?? DEFAULT_ORCHESTRATION.maxTasks,
    maxReplans: project?.max_replans ?? global?.max_replans ?? DEFAULT_ORCHESTRATION.maxReplans,
    maxTaskRetries:
      project?.max_task_retries ?? global?.max_task_retries ?? DEFAULT_ORCHESTRATION.maxTaskRetries,
    maxTaskAttempts:
      project?.max_task_attempts ??
      global?.max_task_attempts ??
      DEFAULT_ORCHESTRATION.maxTaskAttempts,
    maxScopeGrowth:
      project?.max_scope_growth ?? global?.max_scope_growth ?? DEFAULT_ORCHESTRATION.maxScopeGrowth,
    workerTurnTokens:
      project?.worker_turn_tokens ??
      global?.worker_turn_tokens ??
      DEFAULT_ORCHESTRATION.workerTurnTokens,
    workerProgressExtensionTokens:
      project?.worker_progress_extension_tokens ??
      global?.worker_progress_extension_tokens ??
      DEFAULT_ORCHESTRATION.workerProgressExtensionTokens,
    workerMaxTokenMultiplier:
      project?.worker_max_token_multiplier ??
      global?.worker_max_token_multiplier ??
      DEFAULT_ORCHESTRATION.workerMaxTokenMultiplier,
    workerNoProgressTokens:
      project?.worker_no_progress_tokens ??
      global?.worker_no_progress_tokens ??
      DEFAULT_ORCHESTRATION.workerNoProgressTokens,
    workerTurnMs:
      project?.worker_turn_ms ?? global?.worker_turn_ms ?? DEFAULT_ORCHESTRATION.workerTurnMs,
    workerThrashRepeats:
      project?.worker_thrash_repeats ??
      global?.worker_thrash_repeats ??
      DEFAULT_ORCHESTRATION.workerThrashRepeats,
    protectExistingFiles:
      project?.protect_existing_files ??
      global?.protect_existing_files ??
      DEFAULT_ORCHESTRATION.protectExistingFiles,
    guardPendingScope:
      project?.guard_pending_scope ??
      global?.guard_pending_scope ??
      DEFAULT_ORCHESTRATION.guardPendingScope,
    recoveryEscalation:
      project?.recovery_escalation ??
      global?.recovery_escalation ??
      DEFAULT_ORCHESTRATION.recoveryEscalation,
    finalIntegration:
      project?.final_integration ??
      global?.final_integration ??
      DEFAULT_ORCHESTRATION.finalIntegration,
  };
}
