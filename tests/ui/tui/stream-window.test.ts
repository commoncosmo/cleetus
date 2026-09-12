import { expect, test } from "bun:test";
import {
  LIVE_WINDOW_RESERVE,
  MODAL_RESERVE,
  STREAM_CURSOR,
  TRACKER_RESERVE,
  listWindow,
  liveWindowBudget,
  liveWindowReserve,
  modalBudget,
  proseTail,
  tailLines,
  trackerBudget,
  wrappedRows,
} from "../../../src/ui/tui/stream-window";

test("empty or whitespace-only text yields no lines", () => {
  expect(tailLines("", 20, 10)).toEqual([]);
  expect(tailLines("   \n  ", 20, 10)).toEqual([]);
});

test("returns the single line unchanged when it fits and is under maxLines", () => {
  expect(tailLines("hello world", 20, 10)).toEqual(["hello world"]);
});

test("greedily word-wraps a long line at width", () => {
  expect(tailLines("the quick brown fox", 10, 10)).toEqual(["the quick", "brown fox"]);
});

test("keeps only the last maxLines (tail-follow)", () => {
  expect(tailLines("a\nb\nc\nd\ne", 20, 3)).toEqual(["c", "d", "e"]);
});

test("hard-breaks a word longer than width", () => {
  expect(tailLines("abcdefghij", 4, 10)).toEqual(["abcd", "efgh", "ij"]);
});

test("splits on embedded newlines into separate logical lines", () => {
  expect(tailLines("one two\nthree", 20, 10)).toEqual(["one two", "three"]);
});

test("clamps width and maxLines to at least 1", () => {
  expect(tailLines("ab", 0, 0)).toEqual(["b"]);
});

// proseTail: the windowed live-prose tail that bounds the dynamic region (#122). Mirrors tailLines
// but appends the streaming cursor to the last visual line so the in-flight indicator stays visible.
test("proseTail appends the streaming cursor to the last visual line", () => {
  expect(proseTail("hello world", 20, 10)).toEqual([`hello world${STREAM_CURSOR}`]);
});

test("proseTail bounds output to maxLines even for very long prose (the #122 invariant)", () => {
  const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const out = proseTail(long, 80, 10);
  expect(out.length).toBe(10);
  expect(out[out.length - 1]).toBe(`line 499${STREAM_CURSOR}`);
  expect(out[0]).toBe("line 490");
});

test("proseTail wraps then windows, cursor on the wrapped tail", () => {
  // "the quick brown fox" wraps at width 10 → ["the quick", "brown fox"]; keep last 1 + cursor.
  expect(proseTail("the quick brown fox", 10, 1)).toEqual([`brown fox${STREAM_CURSOR}`]);
});

test("proseTail shows a bare cursor for whitespace-only prose", () => {
  expect(proseTail("   \n ", 20, 10)).toEqual([STREAM_CURSOR]);
});

const base = { reasoningCap: 10, proseCap: 12 };

test("reserve constant is 9", () => {
  expect(LIVE_WINDOW_RESERVE).toBe(9);
});

test("reasoning owns the budget when prose is not yet active", () => {
  // rows 24 → budget 15 → reasoning clamps to its cap 10; prose hidden
  expect(liveWindowBudget(24, { ...base, proseActive: false })).toEqual({
    reasoningLines: 10,
    proseLines: 0,
  });
});

test("prose owns the budget once prose is streaming; reasoning collapses", () => {
  // rows 24 → budget 15 → prose clamps to its cap 12; reasoning 0
  expect(liveWindowBudget(24, { ...base, proseActive: true })).toEqual({
    reasoningLines: 0,
    proseLines: 12,
  });
});

test("a short terminal shrinks the window below the cap", () => {
  // rows 18 → budget 9 → prose is min(12, 9) = 9
  expect(liveWindowBudget(18, { ...base, proseActive: true })).toEqual({
    reasoningLines: 0,
    proseLines: 9,
  });
});

test("a tiny terminal (rows <= reserve) yields zero windows", () => {
  expect(liveWindowBudget(9, { ...base, proseActive: true })).toEqual({
    reasoningLines: 0,
    proseLines: 0,
  });
  expect(liveWindowBudget(5, { ...base, proseActive: false })).toEqual({
    reasoningLines: 0,
    proseLines: 0,
  });
});

test("non-finite or non-positive rows yield zero windows", () => {
  for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(liveWindowBudget(bad, { ...base, proseActive: true })).toEqual({
      reasoningLines: 0,
      proseLines: 0,
    });
  }
});

test("threshold invariant: live height + real chrome stays under rows", () => {
  // real chrome below the windows = reserve - margin = 7; margin = 2.
  const realChrome = LIVE_WINDOW_RESERVE - 2;
  for (const rows of [12, 16, 20, 24, 40, 200]) {
    const b = liveWindowBudget(rows, { ...base, proseActive: true });
    const dynamicHeight = b.proseLines + realChrome; // header is inside realChrome
    if (rows > LIVE_WINDOW_RESERVE) expect(dynamicHeight).toBeLessThan(rows);
  }
});

test("a custom reserve overrides the default", () => {
  // rows 24, reserve 20 → budget 4 → prose min(12,4)=4
  expect(liveWindowBudget(24, { ...base, proseActive: true, reserve: 20 })).toEqual({
    reasoningLines: 0,
    proseLines: 4,
  });
});

test("trackerBudget: nothing to show → no rows at all", () => {
  expect(trackerBudget(40, { active: false, expanded: true, todoCount: 5 })).toEqual({
    bodyRows: 0,
    totalRows: 0,
  });
  expect(trackerBudget(40, { active: true, expanded: true, todoCount: 0 })).toEqual({
    bodyRows: 0,
    totalRows: 0,
  });
});

test("trackerBudget: collapsed is always exactly one row", () => {
  expect(trackerBudget(40, { active: true, expanded: false, todoCount: 40 })).toEqual({
    bodyRows: 0,
    totalRows: 1,
  });
  // Even on a terminal too short to expand into, the resting row still fits.
  expect(trackerBudget(6, { active: true, expanded: false, todoCount: 5 })).toEqual({
    bodyRows: 0,
    totalRows: 1,
  });
});

test("trackerBudget: expanded never asks for more rows than there are todos", () => {
  expect(trackerBudget(40, { active: true, expanded: true, todoCount: 5 })).toEqual({
    bodyRows: 5,
    totalRows: 6,
  });
});

test("trackerBudget: expanded is clamped by terminal height, never negative", () => {
  const tall = trackerBudget(40, { active: true, expanded: true, todoCount: 100 });
  expect(tall.bodyRows).toBe(40 - TRACKER_RESERVE);
  expect(tall.totalRows).toBe(tall.bodyRows + 1);
  // A terminal shorter than the chrome collapses the body rather than overrunning the input.
  expect(trackerBudget(8, { active: true, expanded: true, todoCount: 20 })).toEqual({
    bodyRows: 0,
    totalRows: 1,
  });
});

test("trackerBudget: its rows come out of the live windows via the reserve override", () => {
  const tracker = trackerBudget(40, { active: true, expanded: true, todoCount: 5 });
  const withTracker = liveWindowBudget(40, {
    proseActive: false,
    reasoningCap: 100,
    proseCap: 100,
    reserve: LIVE_WINDOW_RESERVE + tracker.totalRows,
  });
  const without = liveWindowBudget(40, {
    proseActive: false,
    reasoningCap: 100,
    proseCap: 100,
  });
  expect(without.reasoningLines - withTracker.reasoningLines).toBe(tracker.totalRows);
});

test("modalBudget: leaves room for the modal's own chrome under the viewport", () => {
  expect(modalBudget(40)).toBe(40 - MODAL_RESERVE);
  expect(modalBudget(24)).toBe(24 - MODAL_RESERVE);
});

test("modalBudget: never returns less than one row, however short the terminal", () => {
  expect(modalBudget(MODAL_RESERVE)).toBe(1);
  expect(modalBudget(5)).toBe(1);
  expect(modalBudget(0)).toBe(1);
  expect(modalBudget(Number.POSITIVE_INFINITY)).toBe(1);
});

test("listWindow: an empty list yields an empty window and no selection", () => {
  expect(listWindow([], 0, 10)).toEqual({ items: [], selected: -1, above: 0, below: 0 });
});

test("listWindow: a list that fits is returned whole with no overflow markers", () => {
  const items = ["a", "b", "c"];
  expect(listWindow(items, 1, 10)).toEqual({ items, selected: 1, above: 0, below: 0 });
});

test("listWindow: anchors at the top while the selection is in the first half", () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  const w = listWindow(items, 0, 3);
  expect(w.items).toEqual(["a", "b", "c"]);
  expect(w.selected).toBe(0);
  expect(w.above).toBe(0);
  expect(w.below).toBe(3);
});

test("listWindow: centers the selection once it moves off the middle", () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  const w = listWindow(items, 3, 3);
  expect(w.items).toEqual(["c", "d", "e"]);
  expect(w.items[w.selected]).toBe("d");
  expect(w.above).toBe(2);
  expect(w.below).toBe(1);
});

test("listWindow: anchors at the bottom for a selection near the end", () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  const w = listWindow(items, 5, 3);
  expect(w.items).toEqual(["d", "e", "f"]);
  expect(w.items[w.selected]).toBe("f");
  expect(w.above).toBe(3);
  expect(w.below).toBe(0);
});

test("listWindow: the selection is always inside the returned slice", () => {
  const items = Array.from({ length: 50 }, (_, i) => `row-${i}`);
  for (let i = 0; i < items.length; i++) {
    const w = listWindow(items, i, 7);
    expect(w.items).toHaveLength(7);
    expect(w.items[w.selected]).toBe(`row-${i}`);
    expect(w.above + w.items.length + w.below).toBe(items.length);
  }
});

test("listWindow: clamps a selection that outran a shrinking list", () => {
  const items = ["a", "b", "c"];
  expect(listWindow(items, 99, 2).items).toEqual(["b", "c"]);
  expect(listWindow(items, -3, 2).items).toEqual(["a", "b"]);
});

test("listWindow: clamps maxRows to at least one row", () => {
  const w = listWindow(["a", "b", "c"], 1, 0);
  expect(w.items).toEqual(["b"]);
  expect(w.above + w.below).toBe(2);
});

test("wrappedRows: counts word-wrapped visual lines, at least one", () => {
  expect(wrappedRows("", 80)).toBe(1); // an empty chrome line still occupies one row
  expect(wrappedRows("short roster", 80)).toBe(1);
  expect(wrappedRows("the quick brown fox", 10)).toBe(2); // "the quick" / "brown fox"
  expect(wrappedRows("a\nb\nc", 80)).toBe(3); // embedded newlines are separate rows
});

test("liveWindowReserve: sums the real chrome heights that share the viewport with the live tail", () => {
  // Baseline chrome for a plain streaming frame: BusyIndicator(1) + Input(2, incl. its marginTop) +
  // StatusBar(2) + the reasoning 'thinking…' header(1) + margin(2) = 8.
  const base = liveWindowReserve({
    reasoningHeader: true,
    busyIndicator: true,
    queued: false,
    staged: false,
    structuring: false,
    commandPanelLines: 0,
    statusBarLines: 2,
    inputLines: 2,
    trackerRows: 0,
    margin: 2,
  });
  expect(base).toBe(8);
});

test("liveWindowReserve: grows with each extra chrome element so the tail shrinks, never overflows", () => {
  const of = (o: Partial<Parameters<typeof liveWindowReserve>[0]>) =>
    liveWindowReserve({
      reasoningHeader: false,
      busyIndicator: true,
      queued: false,
      staged: false,
      structuring: false,
      commandPanelLines: 0,
      statusBarLines: 2,
      inputLines: 2,
      trackerRows: 0,
      margin: 2,
      ...o,
    });
  const base = of({});
  expect(of({ queued: true })).toBe(base + 2);
  expect(of({ staged: true })).toBe(base + 2);
  expect(of({ structuring: true })).toBe(base + 1);
  expect(of({ trackerRows: 4 })).toBe(base + 4);
  expect(of({ commandPanelLines: 3 })).toBe(base + 3);
  // a wrapped roster that occupies 4 status-bar rows instead of 2 reserves two more
  expect(of({ statusBarLines: 4 })).toBe(base + 2);
});

test("liveWindowReserve: an editor request hides the input, so it reserves no input rows", () => {
  const withInput = liveWindowReserve({
    reasoningHeader: false,
    busyIndicator: false,
    queued: false,
    staged: false,
    structuring: false,
    commandPanelLines: 0,
    statusBarLines: 2,
    inputLines: 2,
    trackerRows: 0,
    margin: 2,
  });
  const noInput = liveWindowReserve({
    reasoningHeader: false,
    busyIndicator: false,
    queued: false,
    staged: false,
    structuring: false,
    commandPanelLines: 0,
    statusBarLines: 2,
    inputLines: 0,
    trackerRows: 0,
    margin: 2,
  });
  expect(withInput - noInput).toBe(2);
});
