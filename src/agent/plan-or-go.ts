import type { PermissionMode } from "../permission/modes";
import { isCodingTask, isExplicitBuild } from "./coding-task";

export interface BuildGate {
  mode: PermissionMode;
  /** Orchestration is configured on / not toggled off this session. */
  orchestrationAvailable: boolean;
  /** The plan-or-go pre-turn prompt is enabled (config). */
  planOrGoEnabled: boolean;
  text: string;
}

export interface BuildPromptDecision {
  /** Whether to show the unified pre-turn prompt at all. */
  show: boolean;
  /** Whether the prompt includes the "Orchestrate" option. */
  showOrchestrate: boolean;
}

/**
 * The unified pre-turn gate. Replaces the silent orchestration auto-engage AND the standalone
 * plan-or-go offer. Orchestration is offered ONLY for an explicit build with orchestration
 * available (so it always asks, never auto-engages); plan/go is offered for any coding task when
 * plan-or-go is enabled. Pure.
 */
export function buildPromptOptions(g: BuildGate): BuildPromptDecision {
  if (g.mode !== "normal") return { show: false, showOrchestrate: false };
  const showOrchestrate = g.orchestrationAvailable && isExplicitBuild(g.text);
  const planOrGo = g.planOrGoEnabled && isCodingTask(g.text);
  return { show: showOrchestrate || planOrGo, showOrchestrate };
}

/**
 * Whether to offer the post-plan-approval "orchestrate or just go" choice. Kept as a named,
 * testable decision (rather than an inline check in the TUI) so future conditions can land here
 * without touching render wiring. Today it mirrors the session orchestration toggle.
 */
export function offerOrchestrateAfterPlan(orchestrationEnabled: boolean): boolean {
  return orchestrationEnabled;
}
