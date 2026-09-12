import type { Message } from "../providers/types";

export interface ModelChoice {
  provider: string;
  model: string;
}

export interface TurnRoutingHints {
  /** Host-owned spec dialogue (drafting, answers, revision, or review). Smart mode keeps the
   * large tier for this runtime turn; callers omit it once implementation or ordinary chat starts. */
  specTurn?: boolean;
  /** Host-owned step handoff: prior transcript stays persisted but is omitted from working context. */
  isolatedPlanStep?: boolean;
  /** Original user wording when a host wraps it; null for automatic workflow prompts. */
  userRequest?: string | null;
  completedStepEvidence?: string;
}

export interface TurnContext extends TurnRoutingHints {
  turnIndex: number;
  messages: Message[];
  /** Index of the real user message that opened this runtime turn. */
  turnStartIndex?: number;
  /** Actual tool outcomes observed so far in this turn. Omitted by preview/static callers. */
  toolProgress?: {
    calls: number;
    failures: number;
    consecutiveFailures: number;
    /** Consecutive successful tool outcomes, mirroring `consecutiveFailures`. Used to expire an
     * active recovery lease once the current tier has demonstrated it's back on track. Omitted by
     * preview/pure callers, in which case a lease is treated as not yet earning release. */
    consecutiveSuccesses?: number;
    /** A retrieval turn returned to broad discovery after already searching once. This is a
     * semantic course reset, not a failed HTTP call, and is evidence that the current tier did
     * not turn its first candidate set into an answer. */
    retrievalStalled?: boolean;
  };
  /** Estimated assembled request size and usable input capacity for the preliminary model. */
  contextPressure?: {
    inputTokens: number;
    capacityTokens: number;
  };
  /** Runtime-owned evidence for cause-specific smart-routing leases. This is intentionally based
   * on durable edits and verification, not model-call counts. */
  routingState?: {
    previousTier: "small" | "large" | null;
    sourceEditEpoch: number;
    verifiedSourceEditEpoch: number;
    /** Edit epoch at which a test/render/build verification most recently failed. Compared
     * against `sourceEditEpoch` by `on_verify_fail` routing; a later edit or a same-epoch pass
     * naturally invalidates a stale value without any explicit reset. */
    failedVerificationEpoch?: number;
    completionAuditActive: boolean;
    /** Once smart routing escalates to recover an observed model/tool failure, the stronger model
     * owns subsequent turns until `smart.deescalateAfterSuccesses` consecutive tool outcomes
     * succeed (see `toolProgress.consecutiveSuccesses`), so successful evidence gathering isn't
     * handed back before it's demonstrably back on track. Reset naturally at the next user turn. */
    recoveryLeaseActive?: boolean;
  };
}
