import { type Actor, type Event, actorOf, isEventVisible } from "../../events/types";
import type { TodoItem } from "../../tools/types";
import { type ActorBadge, type BadgeState, stepBadge } from "./actor-badges";

/** Resolved end-state of a tool call (mirrors the former `endById` value in history.tsx). */
export interface ToolEnd {
  ok: boolean;
  errorMessage?: string;
  diff?: { path: string; before: string; after: string };
  todos?: TodoItem[];
  todosTitle?: string;
  diagnostics?: string;
}

/** One render row: a primary event plus resolved cross-event attachments. */
export interface Row {
  event: Event;
  badge?: ActorBadge; // on-change actor/model badge rendered above this row
  end?: ToolEnd; // tool_call_start only
  reasoningMs?: number | null; // reasoning marker only
  spacerBefore?: boolean; // blank line before this row (user turns after the first)
}

export interface HistoryModel {
  committed: Row[]; // append-only → <Static>
  pending: Row[]; // live tail → dynamic region
  // running derivation state (never rendered):
  modelByRole: Partial<Record<Actor["role"], string>>; // current model per actor role
  reasonByRole: Partial<Record<Actor["role"], string>>; // router reason that made that model current
  badge: BadgeState;
  startTsByCall: Map<string, number>; // model_call_start ts, for reasoning duration
  seenUser: boolean; // whether a real (agent-role) user_input has been seen
  reasoningEnabled: boolean;
  verbose: boolean;
}

/** Events that produce a render row (everything else only updates derivation state). */
const ROW_PRODUCING = new Set([
  "user_input",
  "workflow_command",
  "workflow_result",
  "assistant_message",
  "notice",
  "turn_reverted",
  "reasoning",
  "tool_call_start",
  "error",
]);

/** A row is final unless it is a tool_call_start still awaiting its end. */
function isFinal(row: Row): boolean {
  return row.event.type !== "tool_call_start" || row.end !== undefined;
}

export function emptyHistoryModel(reasoningEnabled: boolean, verbose = false): HistoryModel {
  return {
    committed: [],
    pending: [],
    modelByRole: {},
    reasonByRole: {},
    badge: { lastRole: null, lastModel: null },
    startTsByCall: new Map(),
    seenUser: false,
    reasoningEnabled,
    verbose,
  };
}

/**
 * Advance the model by one event. Pure at the top level (returns a new model object); the
 * internal `startTsByCall` map is mutated in place as a derivation cache (never rendered).
 * Preserves the identity of already-committed `Row` objects — the <Static> append-only invariant.
 */
export function advanceHistory(model: HistoryModel, e: Event): HistoryModel {
  if (!isEventVisible(e, model.verbose)) return model;
  // Semantic verifier JSON is an internal machine protocol. It remains in the durable event log
  // for debugging, while the TUI shows the orchestrator's concise semantic notices instead.
  if (
    e.type === "assistant_message" &&
    (e.payload as { internalProtocol?: boolean } | null)?.internalProtocol
  ) {
    return model;
  }
  switch (e.type) {
    case "model_call_start": {
      const p = e.payload as { callId?: string; model?: string; reason?: string };
      if (p.callId) model.startTsByCall.set(p.callId, e.ts);
      // Step boundary: the prior step's tool rows are final (their tool_call_end and coalesced
      // diagnostics were emitted before this model_call_start — verified in runtime.ts), so settle
      // them into committed now. A finished diff leaves the dynamic region before the next step
      // streams, instead of co-rendering with the live window and re-tripping Ink's clear (#122).
      const newlyCommitted: Row[] = [];
      const stillPending: Row[] = [];
      for (const r of model.pending) (isFinal(r) ? newlyCommitted : stillPending).push(r);
      const modelByRole = p.model
        ? { ...model.modelByRole, [actorOf(e).role]: p.model }
        : model.modelByRole;
      const reasonByRole =
        p.reason !== undefined
          ? { ...model.reasonByRole, [actorOf(e).role]: p.reason }
          : model.reasonByRole;
      if (
        !newlyCommitted.length &&
        modelByRole === model.modelByRole &&
        reasonByRole === model.reasonByRole
      )
        return model;
      return {
        ...model,
        committed: newlyCommitted.length
          ? [...model.committed, ...newlyCommitted]
          : model.committed,
        pending: newlyCommitted.length ? stillPending : model.pending,
        modelByRole,
        reasonByRole,
      };
    }
    case "tool_call_end": {
      const p = e.payload as {
        call: { id: string };
        ok: boolean;
        errorMessage?: string;
        diff?: { path: string; before: string; after: string };
        todos?: TodoItem[];
        todosTitle?: string;
      };
      const pending = model.pending.map((r) =>
        r.event.type === "tool_call_start" &&
        (r.event.payload as { call: { id: string } }).call.id === p.call.id &&
        !r.end
          ? {
              ...r,
              end: {
                ok: p.ok,
                errorMessage: p.errorMessage,
                diff: p.diff,
                todos: p.todos,
                todosTitle: p.todosTitle,
              },
            }
          : r,
      );
      return { ...model, pending };
    }
    case "diagnostics": {
      const p = e.payload as { callId: string; text: string };
      const pending = model.pending.map((r) =>
        r.event.type === "tool_call_start" &&
        (r.event.payload as { call: { id: string } }).call.id === p.callId &&
        r.end
          ? { ...r, end: { ...r.end, diagnostics: p.text } }
          : r,
      );
      return { ...model, pending };
    }
    default: {
      if (!ROW_PRODUCING.has(e.type)) return model;
      if (e.type === "reasoning" && !model.reasoningEnabled) return model;

      // 1) settle: final pending rows move to committed (order preserved)
      const newlyCommitted: Row[] = [];
      const stillPending: Row[] = [];
      for (const r of model.pending) {
        if (isFinal(r)) newlyCommitted.push(r);
        else stillPending.push(r);
      }

      // 2) build the new row (attribute to THIS event's actor's own model + the reason that made
      // it current, so a manual switch isn't mislabeled a router escalation)
      const curModel = model.modelByRole[actorOf(e).role] ?? "";
      const curReason = model.reasonByRole[actorOf(e).role];
      const { badge, next } = stepBadge(model.badge, e, curModel, curReason);
      let reasoningMs: number | null | undefined;
      if (e.type === "reasoning") {
        const callId = (e.payload as { callId?: string }).callId ?? "";
        const startTs = model.startTsByCall.get(callId);
        reasoningMs = startTs === undefined ? null : e.ts - startTs;
      }
      let spacerBefore: boolean | undefined;
      let seenUser = model.seenUser;
      // Only a real agent turn (not a down-passed worker handoff) gets a spacer + advances seenUser.
      if (
        (e.type === "user_input" || e.type === "workflow_command") &&
        actorOf(e).role === "agent"
      ) {
        spacerBefore = model.seenUser;
        seenUser = true;
      }
      const row: Row = { event: e, badge, reasoningMs, spacerBefore };

      // An assistant_message is the visible answer and takes no further updates (unlike a tool row,
      // which stays pending for its end + diagnostics). Left full-height in the dynamic region until
      // the next step boundary / idle, a finished answer trips Ink's `clearTerminal` reprint on a
      // short terminal and duplicates into scrollback (the "duplicate final answer" bug). So commit
      // it straight to <Static> now — but only when nothing in-flight precedes it (`stillPending`
      // empty), so committed order stays chronological; otherwise fall back to the park-and-settle
      // path (the in-flight tool settles first, then this answer follows).
      if (e.type === "assistant_message" && stillPending.length === 0) {
        return {
          ...model,
          committed: [...model.committed, ...newlyCommitted, row],
          pending: [],
          badge: next,
          seenUser,
        };
      }
      stillPending.push(row);

      return {
        ...model,
        committed: newlyCommitted.length
          ? [...model.committed, ...newlyCommitted]
          : model.committed,
        pending: stillPending,
        badge: next,
        seenUser,
      };
    }
  }
}

/**
 * Move every final (non-in-flight) pending row into committed, preserving order; in-flight tool
 * rows (awaiting their tool_call_end) stay pending. Returns the SAME model reference when nothing
 * settles, so a caller can skip a needless re-render, and preserves the identity of every existing
 * committed Row (the append-only `<Static>` invariant).
 *
 * The dynamic (non-`<Static>`) region must hold only in-flight rows. A finished answer left there
 * renders full-height, and on a terminal shorter than the answer that drives `outputHeight >= rows`
 * — Ink then takes its `clearTerminal` branch (ink.js) and reprints the whole static transcript,
 * visibly duplicating the answer into scrollback (the "duplicate final answer" bug). The per-event
 * reducer already settles finals at the next step boundary (`model_call_start`), but the LAST
 * answer of a turn has no following event; the app calls this when the turn goes idle to settle it.
 */
export function settlePending(model: HistoryModel): HistoryModel {
  if (model.pending.length === 0) return model;
  const newlyCommitted: Row[] = [];
  const stillPending: Row[] = [];
  for (const r of model.pending) (isFinal(r) ? newlyCommitted : stillPending).push(r);
  if (newlyCommitted.length === 0) return model;
  return { ...model, committed: [...model.committed, ...newlyCommitted], pending: stillPending };
}

/** Build a model by folding a (non-chunk) event list — used at session load / swap. */
export function seedHistory(
  events: Event[],
  reasoningEnabled: boolean,
  verbose = false,
): HistoryModel {
  let m = emptyHistoryModel(reasoningEnabled, verbose);
  for (const e of events) m = advanceHistory(m, e);
  return m;
}
