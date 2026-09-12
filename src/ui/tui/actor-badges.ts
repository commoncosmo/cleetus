import { type Actor, type Event, actorOf } from "../../events/types";

export interface ActorBadge {
  role: Actor["role"];
  model: string;
  /** True only for an automatic router escalation (same actor, new model, escalation reason) — not
   *  a manual model switch. See `isEscalationReason`. */
  escalated: boolean;
}

/** Running state for incremental badge derivation. */
export interface BadgeState {
  lastRole: Actor["role"] | null;
  lastModel: string | null;
}

/** Rows that are attributed to an actor + model (a badge may precede them). */
const ATTRIBUTABLE = new Set(["tool_call_start", "assistant_message", "reasoning", "notice"]);

/**
 * Whether a router decision `reason` (from a `model_call_start`) represents an automatic router
 * escalation — the only cause that earns the "↑ router →" badge. The router stamps escalations as
 * `smart: escalated (…)` (see `agent/router.ts`); a deliberate model switch from the picker stamps
 * `manual`, and other modes stamp `speed: …` / `static`. So a same-actor model change is only an
 * escalation when its reason names it one — never merely because the model differs.
 */
export function isEscalationReason(reason: string | undefined): boolean {
  return reason?.includes("escalated") ?? false;
}

/**
 * One step of on-change badge derivation. Given the prior `state`, an event, the model to attribute
 * to THIS event's actor (`curModel`), and the router `reason` that made that model current
 * (`curReason`), return the badge to render before this event (if the actor/model changed) and the
 * next state. Pure.
 *
 * `curModel` must be the acting actor's own model (see `deriveActorBadges`, which tracks a model
 * per role) — not a single global "latest" model. Otherwise a worker→orchestrator hand-back would
 * mislabel the orchestrator with the worker's model and flag a spurious escalation.
 *
 * A same-actor model change is flagged `escalated` only when `curReason` is a router escalation
 * (see `isEscalationReason`) — a manual switch or a speed-mode change is a plain model badge.
 */
export function stepBadge(
  state: BadgeState,
  e: Event,
  curModel: string,
  curReason?: string,
): { badge?: ActorBadge; next: BadgeState } {
  if (!ATTRIBUTABLE.has(e.type) || curModel === "") return { next: state };
  const role = actorOf(e).role;
  if (role === state.lastRole && curModel === state.lastModel) return { next: state };
  const badge: ActorBadge = {
    role,
    model: curModel,
    escalated:
      role === state.lastRole && curModel !== state.lastModel && isEscalationReason(curReason),
  };
  return { badge, next: { lastRole: role, lastModel: curModel } };
}

/**
 * Compute on-change actor/model badges: a map from the event id a badge precedes to the badge.
 * Thin fold over `stepBadge`, tracking the current model PER ACTOR ROLE (each `model_call_start`
 * is stamped with its actor) so an event is always attributed to its own actor's model.
 */
export function deriveActorBadges(events: Event[]): Map<string, ActorBadge> {
  const out = new Map<string, ActorBadge>();
  const modelByRole = new Map<Actor["role"], string>();
  const reasonByRole = new Map<Actor["role"], string>();
  let state: BadgeState = { lastRole: null, lastModel: null };
  for (const e of events) {
    if (e.type === "model_call_start") {
      const p = e.payload as { model?: string; reason?: string };
      const role = actorOf(e).role;
      if (p.model) modelByRole.set(role, p.model);
      if (p.reason !== undefined) reasonByRole.set(role, p.reason);
      continue;
    }
    const role = actorOf(e).role;
    const curModel = modelByRole.get(role) ?? "";
    const { badge, next } = stepBadge(state, e, curModel, reasonByRole.get(role));
    if (badge) out.set(e.id, badge);
    state = next;
  }
  return out;
}

/** Render text for a badge, e.g. "orchestrator·qwen3.6" or "↑ router → qwen-large". A router
 *  escalation names the router as the mover ("↑ router → model") so it is unmistakable from a
 *  manual model switch, which renders as an ordinary "role·model" badge. */
export function formatActorBadge(b: ActorBadge): { sigil: string; text: string; worker: boolean } {
  const sigil = b.role === "worker" ? "⟐" : "◆";
  const label = b.escalated ? `↑ router → ${b.model}` : `${b.role}·${b.model}`;
  return { sigil, text: label, worker: b.role === "worker" };
}
