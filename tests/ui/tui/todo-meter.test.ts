import { expect, test } from "bun:test";
import type { TodoItem, TodoStatus } from "../../../src/tools/types";
import {
  EMPTY_TRACKER,
  applyTodos,
  completionReceipt,
  formatElapsed,
  hydrateTracker,
  listSignature,
  meterCells,
  trackerHeader,
  trackerRow,
  trackerWindow,
} from "../../../src/ui/tui/todo-meter";

/** Build a list from a status shorthand: "x" completed, ">" in_progress, "." pending. */
function list(shape: string): TodoItem[] {
  const map: Record<string, TodoStatus> = {
    x: "completed",
    ">": "in_progress",
    ".": "pending",
  };
  return [...shape].map((c, i) => ({ content: `task ${i + 1}`, status: map[c]! }));
}

test("meterCells: one cell per todo below the cap", () => {
  expect(meterCells(0, 5)).toBe("▱▱▱▱▱");
  expect(meterCells(2, 5)).toBe("▰▰▱▱▱");
  expect(meterCells(5, 5)).toBe("▰▰▰▰▰");
  expect(meterCells(8, 8)).toBe("▰▰▰▰▰▰▰▰");
});

test("meterCells: past the cap, 8 cells plus the overflow count", () => {
  // 4/14 → round(4/14*8) = 2… but the design mock shows 4 filled; what matters is the
  // shape: 8 cells, "+6" overflow, and a proportional fill.
  expect(meterCells(4, 14)).toBe("▰▰▱▱▱▱▱▱ +6");
  expect(meterCells(7, 14)).toBe("▰▰▰▰▱▱▱▱ +6");
  expect(meterCells(0, 14)).toBe("▱▱▱▱▱▱▱▱ +6");
  expect(meterCells(14, 14)).toBe("▰▰▰▰▰▰▰▰ +6");
});

test("meterCells: a partially-done capped list never reads as empty or full", () => {
  // 1/100 rounds to 0 filled, 99/100 rounds to 8 — both would lie about the boundaries.
  expect(meterCells(1, 100)).toBe("▰▱▱▱▱▱▱▱ +92");
  expect(meterCells(99, 100)).toBe("▰▰▰▰▰▰▰▱ +92");
});

test("meterCells: empty list yields no meter", () => {
  expect(meterCells(0, 0)).toBe("");
});

test("formatElapsed: zero-padded seconds only once a minute is present", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(8_000)).toBe("8s");
  expect(formatElapsed(59_999)).toBe("59s");
  expect(formatElapsed(60_000)).toBe("1m00s");
  expect(formatElapsed(68_000)).toBe("1m08s");
  expect(formatElapsed(172_000)).toBe("2m52s");
  expect(formatElapsed(-5)).toBe("0s");
});

test("hydrateTracker: restores unfinished session work with fresh display clocks", () => {
  const hydrated = hydrateTracker(list("x>."), 42_000);
  expect(hydrated.todos).toEqual(list("x>."));
  expect(hydrated.current).toBe("task 2");
  expect(hydrated.startedAt).toBe(42_000);
  expect(hydrated.listStartedAt).toBe(42_000);
  expect(hydrated.finishedAt).toBeNull();
});

test("hydrateTracker: does not resurrect empty or already-completed lists", () => {
  expect(hydrateTracker([], 42_000)).toBe(EMPTY_TRACKER);
  expect(hydrateTracker(list("xxx"), 42_000)).toBe(EMPTY_TRACKER);
});

test("trackerHeader ①: nothing started → first pending task, no elapsed field", () => {
  expect(
    trackerHeader({
      todos: list("....."),
      busy: true,
      currentElapsedMs: 4_000,
      listElapsedMs: null,
    }),
  ).toBe("▱▱▱▱▱ 0/5 · task 1");
});

test("trackerHeader ②: mid-turn → in_progress task and the live clock", () => {
  expect(
    trackerHeader({
      todos: list("xx>.."),
      busy: true,
      currentElapsedMs: 68_000,
      listElapsedMs: 90_000,
    }),
  ).toBe("▰▰▱▱▱ 2/5 · task 3 · 1m08s");
});

test("trackerHeader ③: turn ended with work outstanding → `paused`, never a stale clock", () => {
  expect(
    trackerHeader({
      todos: list("xxx>."),
      busy: false,
      currentElapsedMs: 68_000,
      listElapsedMs: 90_000,
    }),
  ).toBe("▰▰▰▱▱ 3/5 · task 4 · paused");
});

test("trackerHeader ④: all complete → `done` plus the whole-list elapsed", () => {
  expect(
    trackerHeader({
      todos: list("xxxxx"),
      busy: false,
      currentElapsedMs: null,
      listElapsedMs: 172_000,
    }),
  ).toBe("▰▰▰▰▰ 5/5 done · 2m52s");
});

test("trackerHeader: all complete with no timing → bare `done`", () => {
  expect(
    trackerHeader({ todos: list("xx"), busy: false, currentElapsedMs: null, listElapsedMs: null }),
  ).toBe("▰▰ 2/2 done");
});

test("trackerHeader: empty list renders nothing", () => {
  expect(
    trackerHeader({ todos: [], busy: true, currentElapsedMs: 1_000, listElapsedMs: 1_000 }),
  ).toBe("");
});

test("trackerHeader: the overflow tag sits between the cells and the count", () => {
  const todos = list("xxxx>.........");
  expect(
    trackerHeader({ todos, busy: true, currentElapsedMs: 68_000, listElapsedMs: 90_000 }),
  ).toBe("▰▰▱▱▱▱▱▱ +6 4/14 · task 5 · 1m08s");
});

test("trackerRow: splits the meter for coloring without changing the composed string", () => {
  const input = {
    todos: list("xxxx>........."),
    busy: true,
    currentElapsedMs: 68_000,
    listElapsedMs: null,
  };
  const row = trackerRow(input);
  expect(row.meter.filled).toBe("▰▰");
  expect(row.meter.empty).toBe("▱▱▱▱▱▱");
  expect(row.meter.overflow).toBe("+6");
  expect(row.complete).toBe(false);
  expect(`${row.meter.filled}${row.meter.empty} ${row.text}`).toBe(trackerHeader(input));
});

test("trackerRow: flags the all-complete row so the component can recolor it", () => {
  expect(
    trackerRow({ todos: list("xx"), busy: false, currentElapsedMs: null, listElapsedMs: 1_000 })
      .complete,
  ).toBe(true);
});

test("trackerHeader: header is byte-identical regardless of expansion", () => {
  // The component varies only the right-aligned hint; trackerHeader takes no expansion input
  // at all, which is what makes the invariant unbreakable.
  const input = {
    todos: list("xx>.."),
    busy: true,
    currentElapsedMs: 68_000,
    listElapsedMs: 90_000,
  };
  expect(trackerHeader(input)).toBe(trackerHeader({ ...input }));
});

test("trackerWindow: whole list when it fits", () => {
  const todos = list("xx>..");
  expect(trackerWindow(todos, 5)).toEqual({ above: 0, items: todos, below: 0 });
  expect(trackerWindow(todos, 99)).toEqual({ above: 0, items: todos, below: 0 });
});

test("trackerWindow: anchors on the current task and counts the rest into markers", () => {
  // The design's long-list example: 14 todos, 4 done, in_progress at index 4, 5 rows of budget
  // → ↑ 4 done / three items / ↓ 7 to go.
  const todos = list("xxxx>........."); // 4 completed, 1 in_progress, 9 pending
  expect(todos).toHaveLength(14);
  const w = trackerWindow(todos, 5);
  expect(w.above).toBe(4);
  expect(w.below).toBe(7);
  expect(w.items.map((t) => t.content)).toEqual(["task 5", "task 6", "task 7"]);
  expect(w.items.length + (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0)).toBe(5);
});

test("trackerWindow: no `above` marker wastes a row when the anchor is the first item", () => {
  const todos = list(">....."); // 6 items, anchor at 0, budget 5
  const w = trackerWindow(todos, 5);
  expect(w.above).toBe(0);
  expect(w.items).toHaveLength(4);
  expect(w.below).toBe(2);
});

test("trackerWindow: slides back when the anchor is too near the end to fill the window", () => {
  const todos = list("xxxxx>"); // anchor at index 5 of 6, budget 4
  const w = trackerWindow(todos, 4);
  expect(w.below).toBe(0);
  expect(w.items.map((t) => t.content)).toEqual(["task 4", "task 5", "task 6"]);
  expect(w.above).toBe(3);
  expect(w.items.length + 1).toBe(4);
});

test("trackerWindow: falls back to first pending, then index 0, when nothing is in progress", () => {
  expect(trackerWindow(list("xx...."), 3).items[0]!.content).toBe("task 3");
  // All complete: no pending, no in_progress → anchor at the top.
  expect(trackerWindow(list("xxxxxx"), 3).items[0]!.content).toBe("task 1");
});

test("trackerWindow: a budget too small for markers shows a bare slice, never overruns", () => {
  const todos = list("x>...");
  for (const maxRows of [1, 2, 3, 4, 5]) {
    const w = trackerWindow(todos, maxRows);
    const rows = w.items.length + (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0);
    expect(rows).toBeLessThanOrEqual(maxRows);
    expect(w.items.length).toBeGreaterThan(0);
  }
});

test("trackerWindow: degenerate budgets render nothing", () => {
  expect(trackerWindow(list("x>."), 0)).toEqual({ above: 0, items: [], below: 0 });
  expect(trackerWindow([], 5)).toEqual({ above: 0, items: [], below: 0 });
});

test("listSignature: status changes preserve the signature, content changes break it", () => {
  expect(listSignature(list("..."))).toBe(listSignature(list("x>.")));
  expect(listSignature(list("..."))).not.toBe(listSignature(list("....")));
});

test("completionReceipt: pluralizes and omits timing when unknown", () => {
  expect(completionReceipt(5, 172_000)).toBe("✓ 5 todos completed in 2m52s");
  expect(completionReceipt(1, 8_000)).toBe("✓ 1 todo completed in 8s");
  expect(completionReceipt(3, null)).toBe("✓ 3 todos completed");
});

test("applyTodos: an empty list resets everything", () => {
  const seeded = applyTodos(EMPTY_TRACKER, list("x>."), 1_000);
  expect(applyTodos(seeded, [], 2_000)).toEqual(EMPTY_TRACKER);
});

test("applyTodos: the clock starts at the first in_progress transition", () => {
  const written = applyTodos(EMPTY_TRACKER, list("..."), 1_000);
  expect(written.startedAt).toBeNull();
  expect(written.listStartedAt).toBeNull();

  const started = applyTodos(written, list(">.."), 5_000);
  expect(started.current).toBe("task 1");
  expect(started.startedAt).toBe(5_000);
  expect(started.listStartedAt).toBe(5_000);
});

test("applyTodos: moving to the next task restarts the task clock, not the list clock", () => {
  const a = applyTodos(EMPTY_TRACKER, list(">.."), 5_000);
  const b = applyTodos(a, list("x>."), 9_000);
  expect(b.startedAt).toBe(9_000);
  expect(b.listStartedAt).toBe(5_000);
});

test("applyTodos: re-writing the same list leaves the task clock alone", () => {
  const a = applyTodos(EMPTY_TRACKER, list("x>."), 5_000);
  const b = applyTodos(a, list("x>."), 9_000);
  expect(b.startedAt).toBe(5_000);
  expect(b.listStartedAt).toBe(5_000);
});

test("applyTodos: completing the list freezes finishedAt and keeps the list clock", () => {
  const a = applyTodos(EMPTY_TRACKER, list(">."), 5_000);
  const b = applyTodos(a, list("x>"), 9_000);
  const done = applyTodos(b, list("xx"), 12_000);
  expect(done.finishedAt).toBe(12_000);
  expect(done.listStartedAt).toBe(5_000);
  expect(done.current).toBeNull();
  expect(done.startedAt).toBeNull();
  // A repaint of the same finished list must not advance the frozen total.
  expect(applyTodos(done, list("xx"), 30_000).finishedAt).toBe(12_000);
});

test("applyTodos: a different list resets all three clocks", () => {
  const done = applyTodos(applyTodos(EMPTY_TRACKER, list(">"), 5_000), list("x"), 9_000);
  expect(done.finishedAt).toBe(9_000);
  const next = applyTodos(done, [{ content: "something else", status: "in_progress" }], 20_000);
  expect(next.startedAt).toBe(20_000);
  expect(next.listStartedAt).toBe(20_000);
  expect(next.finishedAt).toBeNull();
});

test("applyTodos: reopening a completed list clears finishedAt", () => {
  const done = applyTodos(applyTodos(EMPTY_TRACKER, list(">"), 5_000), list("x"), 9_000);
  const reopened = applyTodos(done, [{ content: "task 1", status: "in_progress" }], 11_000);
  expect(reopened.finishedAt).toBeNull();
  expect(reopened.listStartedAt).toBe(5_000);
});

test("applyTodos: the header reads `paused` off a frozen clock once the turn ends", () => {
  const s = applyTodos(EMPTY_TRACKER, list("x>."), 5_000);
  expect(
    trackerHeader({
      todos: s.todos,
      busy: false,
      currentElapsedMs: 99_000 - (s.startedAt ?? 0),
      listElapsedMs: null,
    }),
  ).toContain("paused");
});
