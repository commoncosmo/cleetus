import { actorOf } from "../../events/types";
import type { TodoItem } from "../../tools/types";

/** Pure formatters for the persistent todo tracker (design_handoff_todo_tracker). No React,
 *  no theme — the component sits atop these and paints the strings with `Theme` roles. */

const FILLED = "▰";
const EMPTY = "▱";
const METER_CAP = 8;
const SEP = " · ";

/** The meter split into independently colorable runs: filled cells take `theme.accent`, empty
 *  cells the dimmer role, and the overflow tag rides with the header text. */
export interface MeterParts {
  filled: string;
  empty: string;
  /** `"+6"` past the cap, else `""`. Rendered with the header text, not the cells. */
  overflow: string;
}

/**
 * Progress meter cells. Up to {@link METER_CAP} cells one-per-todo; past that, cap at
 * {@link METER_CAP} and append ` +N` for the hidden remainder. Filled count when capped is
 * `round(done / total * CAP)`, clamped so a partially-done list never shows 0 or a full CAP —
 * those boundaries mean "nothing started" and "all done", and must not lie.
 */
export function meterParts(done: number, total: number): MeterParts {
  if (total <= 0) return { filled: "", empty: "", overflow: "" };
  const d = Math.max(0, Math.min(total, Math.floor(done)));
  if (total <= METER_CAP) {
    return { filled: FILLED.repeat(d), empty: EMPTY.repeat(total - d), overflow: "" };
  }
  let filled: number;
  if (d === 0) filled = 0;
  else if (d === total) filled = METER_CAP;
  else {
    filled = Math.round((d / total) * METER_CAP);
    if (filled <= 0) filled = 1;
    if (filled >= METER_CAP) filled = METER_CAP - 1;
  }
  return {
    filled: FILLED.repeat(filled),
    empty: EMPTY.repeat(METER_CAP - filled),
    overflow: `+${total - METER_CAP}`,
  };
}

/** The meter as one string — what {@link trackerHeader} embeds and what tests read. */
export function meterCells(done: number, total: number): string {
  const m = meterParts(done, total);
  return m.overflow ? `${m.filled}${m.empty} ${m.overflow}` : m.filled + m.empty;
}

/** `0` → `"0s"`; `59_000` → `"59s"`; `68_000` → `"1m08s"`; `172_000` → `"2m52s"`. Zero-padded
 *  seconds when a minute component is present, matching the mock. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export interface TrackerHeaderInput {
  todos: TodoItem[];
  /** True while a turn is in flight — a running in_progress uses the live elapsed. */
  busy: boolean;
  /** Wall-clock ms elapsed on the current in_progress task; ignored when not busy. */
  currentElapsedMs: number | null;
  /** Wall-clock ms from the list's first in_progress transition; used for the all-done row. */
  listElapsedMs: number | null;
}

/** The header split at the meter, so the component can color the cells without re-deriving
 *  any of the text. `text` is everything after the meter's trailing space. */
export interface TrackerRow {
  meter: MeterParts;
  /** `<done>/<total> · <task> · <last>` — the overflow tag is prepended here, not in `meter`. */
  text: string;
  /** True when every todo is complete: the whole row switches to `theme.success`. */
  complete: boolean;
}

/**
 * The invariant header row. Byte-identical in collapsed and expanded states — only the
 * right-aligned `^t` hint changes, and that is not part of this string. Pure.
 *
 * - No todos → empty `text` (caller must not render the tracker at all).
 * - All complete → `N/N done · <elapsed>` (elapsed omitted when unknown).
 * - Otherwise task is the in_progress item, else the first pending one — falling back rather
 *   than showing nothing keeps the row from changing shape at the start of every turn.
 * - The last field is the live clock while busy, `paused` when not, and omitted entirely until
 *   something has actually been in progress.
 */
export function trackerRow(input: TrackerHeaderInput): TrackerRow {
  const { todos, busy, currentElapsedMs, listElapsedMs } = input;
  const total = todos.length;
  if (total === 0) {
    return { meter: { filled: "", empty: "", overflow: "" }, text: "", complete: false };
  }
  const done = todos.filter((t) => t.status === "completed").length;
  const meter = meterParts(done, total);
  const lead = meter.overflow ? `${meter.overflow} ${done}/${total}` : `${done}/${total}`;

  if (done === total) {
    const parts = [`${lead} done`];
    if (listElapsedMs !== null) parts.push(formatElapsed(listElapsedMs));
    return { meter, text: parts.join(SEP), complete: true };
  }

  const inProgIdx = todos.findIndex((t) => t.status === "in_progress");
  const firstPendingIdx = todos.findIndex((t) => t.status === "pending");
  const taskIdx = inProgIdx >= 0 ? inProgIdx : firstPendingIdx;

  const parts = [lead];
  if (taskIdx >= 0) parts.push(todos[taskIdx]!.content);
  if (inProgIdx >= 0) {
    if (!busy) parts.push("paused");
    else if (currentElapsedMs !== null) parts.push(formatElapsed(currentElapsedMs));
  }
  return { meter, text: parts.join(SEP), complete: false };
}

/** The whole header row as one string, meter included — the form the invariant is stated in. */
export function trackerHeader(input: TrackerHeaderInput): string {
  const { meter, text } = trackerRow(input);
  if (!text) return "";
  return `${meter.filled}${meter.empty} ${text}`;
}

export interface TrackerWindow {
  /** Number of items scrolled above the visible slice (0 → no `↑ N done` marker). */
  above: number;
  items: TodoItem[];
  /** Number of items scrolled below the visible slice (0 → no `↓ N to go` marker). */
  below: number;
}

/**
 * Slice `todos` to fit `maxRows` of body budget. The window is **anchored at the current task**
 * (in_progress, else first pending) and extends forward — what is left to do is what you need to
 * see, so finished work collapses into the `↑ N done` marker. Backs up only when the anchor sits
 * too near the end to fill the window. Pure.
 *
 * `maxRows` is the total body budget *including* the marker rows, so
 * `items.length + (above>0) + (below>0) <= maxRows` always holds. Markers are dropped when the
 * budget is too small to seat even one alongside an item.
 */
export function trackerWindow(todos: TodoItem[], maxRows: number): TrackerWindow {
  const total = todos.length;
  if (total === 0 || maxRows <= 0) return { above: 0, items: [], below: 0 };
  if (maxRows >= total) return { above: 0, items: todos.slice(), below: 0 };

  const focus = findFocus(todos);
  // Largest item count whose window plus its own markers still fits the budget.
  for (let count = maxRows; count >= 1; count--) {
    const { start, end } = anchored(total, focus, count);
    const above = start;
    const below = total - end;
    const markers = (above > 0 ? 1 : 0) + (below > 0 ? 1 : 0);
    if (count + markers <= maxRows) {
      return { above, items: todos.slice(start, end), below };
    }
  }
  // Budget too small to seat any marker — show the bare slice rather than overrunning it.
  const { start, end } = anchored(total, focus, maxRows);
  return { above: 0, items: todos.slice(start, end), below: 0 };
}

/** `count` items starting at `focus`, sliding back only when the tail is too short to fill it. */
function anchored(total: number, focus: number, count: number): { start: number; end: number } {
  const end = Math.min(total, focus + count);
  return { start: Math.max(0, end - count), end };
}

function findFocus(todos: TodoItem[]): number {
  const inProg = todos.findIndex((t) => t.status === "in_progress");
  if (inProg >= 0) return inProg;
  const firstPending = todos.findIndex((t) => t.status === "pending");
  if (firstPending >= 0) return firstPending;
  return 0;
}

/** Content-only signature for detecting a fresh list vs a status update on the same list.
 *  Two lists with the same item contents in the same order share a signature — status
 *  changes must not reset the whole-list elapsed timer. */
export function listSignature(todos: TodoItem[]): string {
  return todos.map((t) => t.content).join(" ");
}

/**
 * The session working list an event carries, or null when the event leaves the tracker alone.
 * This is the whole scope rule in one place:
 *
 * - `tool_call_end` with `todos` and **no** `todosTitle` is the working list (todo_write,
 *   todo_list_load, the restore seed). A `todosTitle` means a *named* list, which stays
 *   transcript-only.
 * - Only the main agent's lists count; orchestration workers keep their transcript rendering.
 * - `turn_reverted` replaces the list, or clears it when the rewind cleared it.
 */
export function trackerTodosFrom(event: { type: string; payload: unknown }): TodoItem[] | null {
  const p = event.payload as
    | { todos?: unknown; todosTitle?: unknown; todosCleared?: unknown }
    | null
    | undefined;
  if (!p) return null;
  if (event.type === "turn_reverted") {
    if (p.todosCleared) return [];
    return Array.isArray(p.todos) ? (p.todos as TodoItem[]) : null;
  }
  if (event.type !== "tool_call_end") return null;
  if (p.todosTitle !== undefined) return null;
  if (!Array.isArray(p.todos)) return null;
  if (actorOf(event as { payload: unknown }).role !== "agent") return null;
  return p.todos as TodoItem[];
}

/** Everything the tracker needs beyond the list itself: which task is live and the three
 *  wall-clock marks the header's last field is derived from. */
export interface TrackerState {
  todos: TodoItem[];
  /** `content` of the in_progress item — `TodoItem` has no id, so content is the identity. */
  current: string | null;
  /** When `current` became current; drives the live clock. */
  startedAt: number | null;
  /** The list's first in_progress transition; drives the all-done total. */
  listStartedAt: number | null;
  /** When the list went all-complete, freezing the total for the 2s hold. */
  finishedAt: number | null;
}

export const EMPTY_TRACKER: TrackerState = {
  todos: [],
  current: null,
  startedAt: null,
  listStartedAt: null,
  finishedAt: null,
};

/**
 * Hydrate the persistent widget from a runtime/session snapshot. A fully completed list has
 * already shown its completion receipt in the originating run, so it must not reappear after a
 * resume. Incomplete lists restart their display clocks at the resume boundary.
 */
export function hydrateTracker(todos: TodoItem[], now: number): TrackerState {
  if (todos.length === 0 || todos.every((todo) => todo.status === "completed")) {
    return EMPTY_TRACKER;
  }
  return applyTodos(EMPTY_TRACKER, todos, now);
}

/**
 * Fold a new todo list into the tracker state. Pure — `now` is injected so the timing rules are
 * testable. The clocks are what this exists for:
 *
 * - `startedAt` restarts whenever the *identity* of the in_progress item changes, so completing
 *   task 3 and starting task 4 resets the clock but re-writing the same list does not.
 * - `listStartedAt` is set once, at the list's first in_progress transition, and survives every
 *   subsequent status change — otherwise the all-done total would only measure the last task.
 * - A new list (different contents, in any status) resets all three.
 */
export function applyTodos(prev: TrackerState, todos: TodoItem[], now: number): TrackerState {
  if (todos.length === 0) return EMPTY_TRACKER;
  const fresh = listSignature(prev.todos) !== listSignature(todos);
  const current = todos.find((t) => t.status === "in_progress")?.content ?? null;
  const allDone = todos.every((t) => t.status === "completed");

  const startedAt =
    current === null ? null : fresh || current !== prev.current ? now : prev.startedAt;
  const priorListStart = fresh ? null : prev.listStartedAt;
  const listStartedAt = priorListStart ?? (current !== null ? now : null);
  const priorFinish = fresh ? null : prev.finishedAt;
  const finishedAt = allDone ? (priorFinish ?? now) : null;

  return { todos, current, startedAt, listStartedAt, finishedAt };
}

/** The completion receipt written to the transcript once the tracker unmounts.
 *  `✓ N todos completed in <elapsed>` — matches the design's state-⑤ notice line. */
export function completionReceipt(count: number, listElapsedMs: number | null): string {
  const noun = count === 1 ? "todo" : "todos";
  if (listElapsedMs === null) return `✓ ${count} ${noun} completed`;
  return `✓ ${count} ${noun} completed in ${formatElapsed(listElapsedMs)}`;
}
