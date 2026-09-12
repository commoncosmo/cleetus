import type { SmartConfig } from "../config/types";
import type { Message } from "../providers/types";
import { stripSystemReminders } from "../skills/compose";
import { hasImplementationWrite } from "./change-kind";
import { classifyTask } from "./coding-task";
import type { RouteMode } from "./route-modes";
import type { ModelChoice, TurnContext } from "./selector";

export interface Tiers {
  small: ModelChoice;
  large: ModelChoice;
}

export interface RouteDecision {
  choice: ModelChoice;
  tier: "small" | "large" | null;
  reason: string;
  /** Requests turn-scoped ownership by the recovery tier through the final response. */
  lease?: "recovery";
}

export interface Router {
  /** Per loop iteration: which model to use now. */
  select(ctx: TurnContext): RouteDecision;
  /**
   * A small model that emitted reasoning but completed without an answer or tool call has
   * demonstrated a capability failure. Smart routing may provide one stronger recovery choice;
   * other modes return null and retain their configured model semantics.
   */
  recoverFromReasonedEmpty?(ctx: TurnContext, failed: RouteDecision): RouteDecision | null;
  /**
   * Consulted when the turn ends with a final answer. Non-null ⇒ the runtime
   * does one extra tool-less synthesis call with this model (speed mode only).
   */
  finishPass(): RouteDecision | null;
  /** Whether the small tier should be offered `request_escalation` this turn — true only in
   * smart mode with tiers configured, since the tool is meaningless (and hidden) otherwise. */
  supportsEscalationRequest?(): boolean;
}

export interface RouterDeps {
  getMode: () => RouteMode;
  getActive: () => ModelChoice;
  tiers?: Tiers;
  smart: SmartConfig;
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.content;
  }
  return "";
}

function currentTurnMessages(messages: Message[], turnStartIndex?: number): Message[] {
  if (
    turnStartIndex !== undefined &&
    Number.isInteger(turnStartIndex) &&
    turnStartIndex >= 0 &&
    turnStartIndex < messages.length
  ) {
    return messages.slice(turnStartIndex);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages.slice(i);
  }
  return messages;
}

/** The user's own words for the current turn. The runtime appends `<system-reminder>` blocks
 * (location grounding, auto-invoked skills, plan mode, …) to the turn message for the model's
 * benefit; those are stripped here so Cleetus's own guidance can't change the routing class or
 * trip a keyword (#319 — the grounding reminder's "Build the project…" read as an explicit build). */
function turnUserText(messages: Message[], turnStartIndex?: number): string {
  const raw =
    turnStartIndex !== undefined &&
    Number.isInteger(turnStartIndex) &&
    turnStartIndex >= 0 &&
    messages[turnStartIndex]?.role === "user"
      ? messages[turnStartIndex]!.content
      : lastUserText(messages);
  return stripSystemReminders(raw);
}

/** Whether the current turn's history contains a `request_escalation` tool call (see
 * `RequestEscalationTool`). Mirrors `hasImplementationWrite`'s current-turn scan: a call from a
 * prior, completed turn doesn't count. */
function hasEscalationRequest(ctx: TurnContext): boolean {
  return currentTurnMessages(ctx.messages, ctx.turnStartIndex).some((message) =>
    message.toolCalls?.some((call) => call.name === "request_escalation"),
  );
}

/** Whether the current turn's history contains a `todo_write` tool call — the signal that an
 * explicit build request has moved from planning into execution. Mirrors `hasEscalationRequest`'s
 * current-turn scan: a call from a prior, completed turn doesn't count. */
function hasTodoPlan(ctx: TurnContext): boolean {
  return currentTurnMessages(ctx.messages, ctx.turnStartIndex).some((message) =>
    message.toolCalls?.some((call) => call.name === "todo_write"),
  );
}

function sourceEditLeaseActive(ctx: TurnContext): boolean {
  if (!hasImplementationWrite(currentTurnMessages(ctx.messages, ctx.turnStartIndex))) return false;
  // Preview and pure callers have no runtime evidence, so preserve the conservative behavior.
  if (!ctx.routingState) return true;
  return (
    ctx.routingState.sourceEditEpoch > 0 &&
    ctx.routingState.verifiedSourceEditEpoch < ctx.routingState.sourceEditEpoch
  );
}

/** Whether a qualifying (test/render/build) verification has failed at the current edit epoch
 * and that failure hasn't since been superseded by a passing verification at the same epoch.
 * Undefined `routingState` (preview/pure callers) means no failure evidence exists, so this
 * returns false — the inverse of `sourceEditLeaseActive`'s conservative-escalate default, since
 * `on_verify_fail` escalates only on observed failure, never on the edit's mere existence. */
function verificationFailedSinceEdit(ctx: TurnContext): boolean {
  const state = ctx.routingState;
  if (!state) return false;
  const failedEpoch = state.failedVerificationEpoch ?? 0;
  return (
    failedEpoch > 0 &&
    failedEpoch === state.sourceEditEpoch &&
    state.verifiedSourceEditEpoch < state.sourceEditEpoch
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary match so a keyword only fires on itself, not as a substring inside an unrelated
 * word (e.g. "test" inside "testing", "think hard" inside "rethink hard"). A `\b` boundary
 * requires a word-char/non-word-char transition, so this naturally rejects those cases without
 * needing to special-case letter-boundary adjacency. */
function matchedKeyword(
  messages: Message[],
  keywords: string[],
  turnStartIndex?: number,
): string | null {
  const text = turnUserText(messages, turnStartIndex).toLowerCase();
  for (const kw of keywords) {
    const pattern = new RegExp(`\\b${escapeRegExp(kw.toLowerCase())}\\b`);
    if (pattern.test(text)) return kw;
  }
  return null;
}

/** `/spec` and its explicit skill equivalent are drafting turns, not the capped planning phase
 * of a broad implementation request. Keep their strongest configured tier for the whole turn. */
function isSpecTurn(text: string): boolean {
  return /^\/spec(?:\s|$)|^\/skill\s+spec-creator(?:\s|$)/i.test(text);
}

function evaluateSmart(
  ctx: TurnContext,
  smart: SmartConfig,
): { escalate: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const consecutiveSuccesses = ctx.toolProgress?.consecutiveSuccesses ?? 0;
  if (
    ctx.routingState?.recoveryLeaseActive &&
    consecutiveSuccesses < smart.deescalateAfterSuccesses
  ) {
    reasons.push("recovery_in_progress");
  }
  if (ctx.toolProgress && ctx.toolProgress.consecutiveFailures >= smart.escalateAfterFailures) {
    reasons.push(`consecutive_tool_failures>=${smart.escalateAfterFailures}`);
  }
  if (ctx.toolProgress?.retrievalStalled) reasons.push("retrieval_stalled");
  if (ctx.contextPressure) {
    const { inputTokens, capacityTokens } = ctx.contextPressure;
    const percent = capacityTokens > 0 ? (inputTokens / capacityTokens) * 100 : 100;
    if (percent >= smart.contextWindowPercent) {
      reasons.push(`context_pressure>=${smart.contextWindowPercent}%`);
    }
  }
  const userText = turnUserText(ctx.messages, ctx.turnStartIndex);
  if (ctx.specTurn || isSpecTurn(userText)) reasons.push("spec_turn");
  const taskClass = classifyTask(userText);
  const editMode = smart.escalateOnCodeEdit;
  const stillPlanningBroadCode = !hasTodoPlan(ctx) && ctx.turnIndex < smart.broadCodePlanCalls;
  if (editMode !== "never" && taskClass === "broad_code" && stillPlanningBroadCode) {
    reasons.push("broad_code");
  } else if (editMode === "always" && sourceEditLeaseActive(ctx)) {
    reasons.push("source_edit_pending_verification");
  } else if (editMode === "on_verify_fail" && verificationFailedSinceEdit(ctx)) {
    reasons.push("verification_failed_pending_fix");
  }
  if (ctx.routingState?.completionAuditActive) reasons.push("completion_audit");
  if (hasEscalationRequest(ctx)) reasons.push("model_requested");
  const kw = matchedKeyword(ctx.messages, smart.keywords, ctx.turnStartIndex);
  if (kw) reasons.push(`keyword:${kw}`);
  return { escalate: reasons.length > 0, reasons };
}

export function createRouter(deps: RouterDeps): Router {
  return {
    select(ctx) {
      const mode = deps.getMode();
      if (mode === "manual") {
        return { choice: deps.getActive(), tier: null, reason: "manual" };
      }
      // Defensive totality: startup + /route guard against this, but never throw.
      if (!deps.tiers) {
        return { choice: deps.getActive(), tier: null, reason: `${mode}: no tiers, using active` };
      }
      if (mode === "speed") {
        return { choice: deps.tiers.small, tier: "small", reason: "speed: gather" };
      }
      // smart
      const { escalate, reasons } = evaluateSmart(ctx, deps.smart);
      if (escalate) {
        const recovery = reasons.some(
          (reason) =>
            reason === "recovery_in_progress" ||
            reason === "retrieval_stalled" ||
            reason === "model_requested" ||
            reason.startsWith("consecutive_tool_failures"),
        );
        return {
          choice: deps.tiers.large,
          tier: "large",
          reason: `smart: escalated (${reasons.join(", ")})`,
          ...(recovery ? { lease: "recovery" as const } : {}),
        };
      }
      const released = ctx.routingState?.previousTier === "large";
      return {
        choice: deps.tiers.small,
        tier: "small",
        reason: released
          ? "smart: small (lease released: escalation conditions resolved)"
          : "smart: small",
      };
    },
    recoverFromReasonedEmpty(_ctx, failed) {
      if (deps.getMode() !== "smart" || !deps.tiers || failed.tier !== "small") return null;
      return {
        choice: deps.tiers.large,
        tier: "large",
        reason: "smart: escalated (small_reasoned_empty)",
        lease: "recovery",
      };
    },
    finishPass() {
      if (deps.getMode() === "speed" && deps.tiers) {
        return { choice: deps.tiers.large, tier: "large", reason: "speed: finish" };
      }
      return null;
    },
    supportsEscalationRequest() {
      return deps.getMode() === "smart" && !!deps.tiers;
    },
  };
}

/** A trivial fixed-choice router (used by tests and any always-one-model caller). */
export function staticRouter(choice: ModelChoice): Router {
  return {
    select: () => ({ choice, tier: null, reason: "static" }),
    finishPass: () => null,
  };
}
