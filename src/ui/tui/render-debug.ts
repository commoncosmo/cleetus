import { appendFileSync } from "node:fs";

/**
 * Env-gated render diagnostics for the intermittent "duplicate final answer" bug (ctest nemo2).
 *
 * Root-cause hypothesis: when the dynamic (non-`<Static>`) region grows taller than the terminal,
 * Ink abandons differential updates and takes its full-screen-clear branch
 * (`node_modules/ink/build/ink.js:121`: `outputHeight >= stdout.rows` →
 * `write(ansiEscapes.clearTerminal + fullStaticOutput + output)`). A tall, just-committed
 * assistant-message row can bake its top into the terminal scrollback and then be reprinted whole,
 * which is the visible double. This module records evidence so the NEXT occurrence is captured
 * deterministically instead of guessed at.
 *
 * Everything here is a no-op unless `CLEETUS_RENDER_DEBUG` is set, so it costs nothing in normal use.
 * The pure helpers are unit-tested; the sink is a thin JSONL appender.
 */

/** True when render diagnostics are enabled (env var set to a non-empty value). Pure. */
export function renderDebugEnabled(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CLEETUS_RENDER_DEBUG);
}

/**
 * Ink's full-screen-clear signature. `ansiEscapes.clearTerminal` on a non-legacy-Windows terminal
 * is `\x1b[2J\x1b[3J\x1b[H`; the `\x1b[3J` (erase-scrollback / ED 3) sub-sequence is what makes it
 * unique — Ink emits it ONLY from the `outputHeight >= rows` branch, never from a differential frame.
 */
export const INK_FULL_CLEAR_MARK = "\u001B[3J";

/** True when a frame Ink wrote contains its full-screen-clear escape (the duplication-causing path). */
export function containsInkFullClear(chunk: string): boolean {
  return chunk.includes(INK_FULL_CLEAR_MARK);
}

/**
 * Estimate the terminal-line height of a text block wrapped to `width`. An approximation — it
 * ignores Markdown table/box expansion, so it under-counts rich rows — but enough to flag a row
 * taller than the viewport, which is all the diagnostic needs. Pure.
 */
export function estimateWrappedLines(text: string, width: number): number {
  const w = Math.max(1, width);
  let lines = 0;
  for (const seg of text.split("\n")) lines += seg.length === 0 ? 1 : Math.ceil(seg.length / w);
  return lines;
}

/** A full-screen-clear frame Ink emitted (the branch that can duplicate scrollback). */
export interface FullClearRecord {
  kind: "full_clear";
  ts: number;
  /** Terminal rows at the moment of the clear (Ink compares dynamic height against this). */
  rows: number | null;
  /** Size of the coalesced frame body, in chars. */
  bytes: number;
  /** Monotonic sequence number within the session, so a burst is legible in order. */
  seq: number;
}

/** A row settling into `<Static>`, with its estimated height vs the viewport. */
export interface CommitRecord {
  kind: "commit";
  ts: number;
  termRows: number;
  rowType: string;
  textLen: number;
  estLines: number;
  eventId: string;
}

export type RenderDebugRecord = FullClearRecord | CommitRecord;

/** Serialize one record as a single JSONL line (no embedded newlines). Pure. */
export function formatRenderDebugLine(rec: RenderDebugRecord): string {
  return JSON.stringify(rec);
}

/** A place to send render-debug records. `log` is a no-op when diagnostics are disabled. */
export interface RenderDebugSink {
  log(rec: RenderDebugRecord): void;
}

const NOOP_SINK: RenderDebugSink = { log: () => {} };

/**
 * A sink that appends JSONL records to `path`. Returns a no-op sink when `enabled` is false, so
 * callers can wire it unconditionally. File-append failures are swallowed — diagnostics must never
 * take down the TUI.
 */
export function createRenderDebugSink(path: string, enabled: boolean): RenderDebugSink {
  if (!enabled) return NOOP_SINK;
  return {
    log(rec) {
      try {
        appendFileSync(path, `${formatRenderDebugLine(rec)}\n`);
      } catch {
        // best-effort diagnostics; never throw into the render loop
      }
    },
  };
}
