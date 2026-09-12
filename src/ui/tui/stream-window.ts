/** Greedy word-wrap one logical line to `width` columns; a single word longer than `width` is
 *  hard-broken into width-sized pieces. A blank/whitespace-only line yields one blank visual line
 *  (so paragraph breaks are preserved). `width` is assumed >= 1 (the caller clamps). */
function wrapLine(line: string, width: number): string[] {
  const words = line.split(/\s+/).filter((x) => x.length > 0);
  if (words.length === 0) return [""];
  const out: string[] = [];
  let cur = "";
  for (let word of words) {
    while (word.length > width) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (cur === "") cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Compute the tail viewport for a live stream (reasoning or prose): split into logical lines,
 * word-wrap each to `width` columns (hard-breaking any single word longer than `width`), flatten,
 * and return the last `maxLines` visual lines. Pure — drives the windowed renders in history.tsx.
 *
 * Bounding the live region this way keeps the dynamic (non-<Static>) output under the terminal
 * height; once it reaches the viewport, Ink full-screen-clears on every frame (ink.js render:
 * `outputHeight >= rows → clearTerminal`), which is the #122 flashing.
 */
export function tailLines(text: string, width: number, maxLines: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const n = Math.max(1, Math.floor(maxLines));
  if (!text.trim()) return [];
  const visual: string[] = [];
  for (const logical of text.split("\n")) visual.push(...wrapLine(logical, w));
  return visual.slice(-n);
}

/**
 * Word-wrapped visual row count for one chrome string at `width` columns — the same greedy wrap the
 * live tail uses, so a chrome element's reserved height matches what Ink will actually render. A
 * blank line still occupies one row; embedded newlines are separate rows. Pure.
 */
export function wrappedRows(text: string, width: number): number {
  const w = Math.max(1, Math.floor(width));
  let n = 0;
  for (const logical of text.split("\n")) n += wrapLine(logical, w).length;
  return Math.max(1, n);
}

/** The live streaming cursor glyph appended to the last visual line of in-flight prose. */
export const STREAM_CURSOR = "▌";

/**
 * Windowed tail of the live (in-flight) prose stream, with the streaming cursor appended to the
 * last visual line. Like {@link tailLines} but for prose: bounding the visible prose to `maxLines`
 * keeps the dynamic region under the viewport so Ink never trips its full-screen clear (#122). The
 * full message is rendered as committed Markdown once the turn commits, so nothing is lost.
 * Whitespace-only prose yields a bare cursor (the streaming indicator stays visible).
 */
export function proseTail(prose: string, width: number, maxLines: number): string[] {
  const lines = tailLines(prose, width, maxLines);
  if (lines.length === 0) return [STREAM_CURSOR];
  lines[lines.length - 1] += STREAM_CURSOR;
  return lines;
}

/** Lines reserved for fixed chrome below the live windows: the "thinking…" header (1) +
 *  BusyIndicator (1) + Input (~3) + StatusBar (2) = 7 real chrome, plus a 2-line safety margin.
 *  Being generous is free; being one line short reinstates Ink's full-screen-clear flash (#122).
 *
 *  A fixed guess, kept as the floor/default. When the real chrome is taller than this (a wrapped
 *  status roster, a queued/staged indicator, an expanded tracker) the live windows overshoot the
 *  viewport and Ink full-screen-clears — which on a terminal that ignores ESC[3J (macOS Terminal)
 *  reprints the committed answer into scrollback (the duplicate-final-answer bug). `liveWindowReserve`
 *  computes the real height instead; this constant is the fallback when nothing is measured. */
export const LIVE_WINDOW_RESERVE = 9;

/** Real heights of the chrome that shares the viewport with the live reasoning/prose tail, in the
 *  order app.tsx stacks it below `<History>`. Every field is a row count already accounting for the
 *  element's own margins; absent elements are 0/false. */
export interface LiveChromeInput {
  /** History's own "thinking…" header sits above the reasoning tail (1 row) while reasoning shows. */
  reasoningHeader: boolean;
  /** The BusyIndicator row (1) — present while streaming, absent behind a prompt/editor. */
  busyIndicator: boolean;
  /** The "⧗ queued" indicator, rendered with a marginTop (2 rows). */
  queued: boolean;
  /** The staged-images indicator, rendered with a marginTop (2 rows). */
  staged: boolean;
  /** The orchestration-structuring status line (1 row). */
  structuring: boolean;
  /** CommandPanel body height (0 when empty). */
  commandPanelLines: number;
  /** StatusBar's rendered height — its roster line can wrap on a narrow terminal, so measure it. */
  statusBarLines: number;
  /** The Input box height including its marginTop, or 0 when an editor request hides the input. */
  inputLines: number;
  /** Rows the TodoTracker occupies (todoBudget.totalRows). */
  trackerRows: number;
  /** Safety headroom on top of the measured chrome. Default 3 — absorbs Ink's per-Box layout
   *  rounding and a transient row the budget can't predict (e.g. the just-settled reasoning marker
   *  lingering in the dynamic region for one frame while prose still streams). */
  margin?: number;
}

/**
 * The live-window reserve as the SUM of the chrome that actually renders below `<History>` this
 * frame, replacing the fixed {@link LIVE_WINDOW_RESERVE} guess. Over-reserving only shrinks the tail
 * (safe); under-reserving lets the dynamic region reach the viewport and trips Ink's full-screen
 * clear — so every field here must count a real row. Pure.
 */
export function liveWindowReserve(c: LiveChromeInput): number {
  return (
    (c.reasoningHeader ? 1 : 0) +
    (c.busyIndicator ? 1 : 0) +
    (c.queued ? 2 : 0) +
    (c.staged ? 2 : 0) +
    (c.structuring ? 1 : 0) +
    Math.max(0, c.commandPanelLines) +
    Math.max(0, c.statusBarLines) +
    Math.max(0, c.inputLines) +
    Math.max(0, c.trackerRows) +
    (c.margin ?? 3)
  );
}

/** Chrome below an expanded todo tracker: everything {@link LIVE_WINDOW_RESERVE} covers, plus the
 *  tracker's own header row. The body is budgeted against what is left, so the expansion can never
 *  push the input off-screen. */
export const TRACKER_RESERVE = LIVE_WINDOW_RESERVE + 1;

export interface TrackerBudget {
  /** Rows the expanded body may use, `↑`/`↓` markers included. 0 when collapsed or starved. */
  bodyRows: number;
  /** Rows the tracker will occupy in total — add to the live windows' reserve. */
  totalRows: number;
}

/**
 * Height budget for the todo tracker. Collapsed it is one row; expanded it takes its header plus
 * as much of the list as fits under `rows` after chrome. Never asks for more rows than there are
 * todos to show. Pure.
 */
export function trackerBudget(
  rows: number,
  opts: { active: boolean; expanded: boolean; todoCount: number },
): TrackerBudget {
  if (!opts.active || opts.todoCount === 0) return { bodyRows: 0, totalRows: 0 };
  if (!opts.expanded) return { bodyRows: 0, totalRows: 1 };
  const available = Number.isFinite(rows) ? Math.floor(rows) - TRACKER_RESERVE : 0;
  const bodyRows = Math.max(0, Math.min(opts.todoCount, available));
  return { bodyRows, totalRows: 1 + bodyRows };
}

/**
 * Chrome below an open picker/modal: everything {@link LIVE_WINDOW_RESERVE} covers, plus the
 * modal's own header row and the two `↑`/`↓` overflow markers a windowed list can show.
 */
export const MODAL_RESERVE = LIVE_WINDOW_RESERVE + 3;

/**
 * Rows a modal's list body may occupy under a terminal of `rows`. Unbounded pickers are the last
 * place the dynamic region can still exceed the viewport: a long session history or checkpoint list
 * renders every row, and once `outputHeight >= rows` Ink takes its `clearTerminal` branch and
 * reprints the ENTIRE static transcript on every frame (ink.js). That is not flicker, it is a
 * strobe, and it gets worse the longer the session runs. Pure.
 */
export function modalBudget(rows: number): number {
  if (!Number.isFinite(rows) || rows <= 0) return 1;
  return Math.max(1, Math.floor(rows) - MODAL_RESERVE);
}

export interface ListWindow<T> {
  /** The visible slice. */
  items: T[];
  /** Index within `items` of the originally-selected element, or -1 if the list is empty. */
  selected: number;
  /** Count of items scrolled off the top; 0 when at the top. */
  above: number;
  /** Count of items scrolled off the bottom; 0 when at the bottom. */
  below: number;
}

/**
 * Scroll a list to a window of at most `maxRows` rows that contains `selected`, keeping the
 * selection in view as it moves off either edge. Clamps `selected` into range so a caller whose
 * index outran a shrinking list still renders. Pure.
 */
export function listWindow<T>(items: T[], selected: number, maxRows: number): ListWindow<T> {
  if (items.length === 0) return { items: [], selected: -1, above: 0, below: 0 };
  const size = Math.max(1, Math.floor(maxRows));
  const idx = Math.max(0, Math.min(items.length - 1, Math.floor(selected)));
  if (items.length <= size) return { items, selected: idx, above: 0, below: 0 };
  // Center the selection where possible, then clamp the window to the ends of the list.
  const half = Math.floor(size / 2);
  const start = Math.max(0, Math.min(items.length - size, idx - half));
  return {
    items: items.slice(start, start + size),
    selected: idx - start,
    above: start,
    below: items.length - (start + size),
  };
}

export interface LiveWindowBudgetInput {
  /** True once the in-flight turn is emitting prose (not just reasoning). */
  proseActive: boolean;
  /** Config ceiling for the reasoning tail (default 10). */
  reasoningCap: number;
  /** Config ceiling for the prose tail (default 12). */
  proseCap: number;
  /** Lines reserved for fixed chrome. Defaults to LIVE_WINDOW_RESERVE. */
  reserve?: number;
}

export interface LiveWindowBudget {
  reasoningLines: number;
  proseLines: number;
}

/**
 * Height budget for the live reasoning/prose windows, sized so the dynamic (non-<Static>) region
 * stays strictly under `rows` and Ink never trips its `clearTerminal` branch (#122). Prose-wins:
 * while prose streams, reasoning collapses to its header (window 0) and prose takes the budget;
 * otherwise reasoning owns it. Config caps are upper bounds the terminal height can shrink. Pure.
 */
export function liveWindowBudget(rows: number, input: LiveWindowBudgetInput): LiveWindowBudget {
  const reserve = input.reserve ?? LIVE_WINDOW_RESERVE;
  const budget = Number.isFinite(rows) && rows > 0 ? Math.max(0, Math.floor(rows) - reserve) : 0;
  if (input.proseActive) {
    return { reasoningLines: 0, proseLines: Math.min(input.proseCap, budget) };
  }
  return { reasoningLines: Math.min(input.reasoningCap, budget), proseLines: 0 };
}
