/**
 * Persistent status-line roster of the model(s) in play. With orchestration off this is just the
 * session model; with it on, the chat / planner / worker roles are listed so it's always obvious
 * which model does what — and which roles merely mirror the session model rather than being pinned.
 */

/** A configured role's resolved display, derived against the live session (`active`) model. */
export interface RosterRole {
  /** "chat" | "planner" | "worker"; "" for the single-model (orchestration-off) line. */
  label: string;
  model: string;
  provider: string;
  /** True when this role fell back to the session model instead of a pinned config value. */
  fromSession: boolean;
}

export interface RosterInput {
  /** Live session model — the universal fallback. */
  active: { provider: string; model: string };
  orchestration: {
    enabled: boolean;
    /** True when orchestration is set up in config (so an OFF state is worth showing). */
    configured?: boolean;
    /** "" → mirror the session model. */
    orchestratorModel: string;
    orchestratorProvider: string;
    workerModel: string;
    workerProvider: string;
  };
}

/**
 * Build the roster roles. Orchestration off → a single, label-less session entry. On → chat
 * (always the session model), planner, and worker, each resolving a pinned value over the session
 * model and flagging `fromSession` when it fell back. Pure.
 */
export function buildModelRoster(input: RosterInput): RosterRole[] {
  const { active, orchestration: o } = input;
  if (!o.enabled) {
    return [{ label: "", model: active.model, provider: active.provider, fromSession: false }];
  }
  const role = (label: string, model: string, provider: string): RosterRole =>
    model
      ? { label, model, provider: provider || active.provider, fromSession: false }
      : { label, model: active.model, provider: active.provider, fromSession: true };
  return [
    { label: "chat", model: active.model, provider: active.provider, fromSession: false },
    role("planner", o.orchestratorModel, o.orchestratorProvider),
    role("worker", o.workerModel, o.workerProvider),
  ];
}

/** Render one roster entry, e.g. `planner nemotron3:33b (lab_ollama)` or `worker gemma (session)`. */
export function formatRosterEntry(r: RosterRole): string {
  const tag = r.fromSession ? "session" : r.provider;
  const base = `${r.model} (${tag})`;
  return r.label ? `${r.label} ${base}` : base;
}

/** Render the full roster line: entries joined by ` · `. Pure. */
export function formatModelRoster(input: RosterInput): string {
  const roles = buildModelRoster(input).map(formatRosterEntry).join(" · ");
  // Configured-but-disabled: show an explicit off marker so it's distinguishable from a
  // session that never had orchestration configured (where the roster stays clean).
  if (!input.orchestration.enabled && input.orchestration.configured) {
    return `orch:off · ${roles}`;
  }
  return roles;
}

/**
 * Planner + worker entries only — for the orchestration kickoff notice, where the chat model is
 * not the point. Returns "" when orchestration is off. Pure.
 */
export function formatOrchestrationRoles(input: RosterInput): string {
  if (!input.orchestration.enabled) return "";
  return buildModelRoster(input)
    .filter((r) => r.label === "planner" || r.label === "worker")
    .map(formatRosterEntry)
    .join(" · ");
}
