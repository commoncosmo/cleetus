import { containsInkFullClear } from "./render-debug";

/**
 * Coalescing, synchronized-output stdout wrapper for Ink.
 *
 * Two problems this solves. Both are mild on a native pty (macOS Terminal.app) and severe through
 * WSL2's conpty bridge, which is why the flashing survived the #122 window-budget work on Linux:
 *
 * 1. Ink writes a frame as `eraseLines(n) + output` (ink/build/log-update.js). conpty drains its
 *    pipe in small chunks and the terminal repaints on each chunk, so a frame larger than the
 *    buffer gets painted two or three times — and one of those paints lands after the erase but
 *    before the redraw. That blank region is the flash. Wrapping each frame in DEC private mode
 *    2026 ("synchronized output") tells the terminal to buffer the whole update and paint it once.
 *
 * 2. Ink's static path issues three separate writes per frame — `log.clear()`, the static chunk,
 *    then the live frame — and `log.clear()` is not throttled (ink/build/ink.js). That guarantees
 *    a blank-then-refill across three flushes every time a message commits to `<Static>`, which is
 *    why the flashing is worst while the transcript is growing. Deferring writes to a microtask
 *    coalesces everything Ink emits during one synchronous `onRender` into a single write, so the
 *    erase and the redraw can never be painted separately.
 *
 * Terminals that do not implement 2026 ignore the sequence (unknown private modes are dropped per
 * ECMA-48), so enabling it is a no-op there rather than a regression. `CLEETUS_NO_SYNC_OUTPUT=1`
 * turns it off anyway, for a terminal that mishandles it.
 */

/** DEC private mode 2026 set — begin a synchronized update. */
export const BEGIN_SYNC = "\u001B[?2026h";
/** DEC private mode 2026 reset — end a synchronized update, painting it atomically. */
export const END_SYNC = "\u001B[?2026l";

/** Minimal shape we need from a writable TTY. Kept structural so tests can pass a fake. */
export interface FrameTarget {
  write(chunk: string): boolean;
  isTTY?: boolean;
  rows?: number;
  columns?: number;
}

/** Ink's own width fallback (`stdout.columns || 80`), and the row fallback `useTerminalRows` uses. */
export const FALLBACK_ROWS = 24;
export const FALLBACK_COLUMNS = 80;

/** A dimension is usable only if it is a finite, positive number. Pure. */
function usableDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export interface FrameWriter<T extends FrameTarget> {
  /** The stream to hand to Ink's `render(node, { stdout })`. */
  stream: T;
  /** Emit any buffered frame immediately. Idempotent; safe after `dispose`. */
  flush: () => void;
  /** Flush, then pass writes straight through. For unmount/exit, so nothing is left buffered. */
  dispose: () => void;
}

/**
 * Whether to wrap frames in synchronized-output markers. Off when explicitly disabled, when the
 * stream is not a TTY (piped output would carry the escapes into the capture), and for `TERM=dumb`.
 * Pure — takes the env rather than reading `process.env`, so it is testable.
 */
export function syncOutputEnabled(
  env: Record<string, string | undefined>,
  target: FrameTarget,
): boolean {
  if (env.CLEETUS_NO_SYNC_OUTPUT) return false;
  if (!target.isTTY) return false;
  if (env.TERM === "dumb" || !env.TERM) return false;
  return true;
}

/**
 * Wrap `target` so that every write Ink makes inside one synchronous turn is buffered and emitted
 * as a single, optionally synchronized, write.
 *
 * The returned `stream` is a Proxy over `target`: only `write` is replaced, so Ink still reads the
 * live `columns`/`rows` and subscribes to `resize` on the real stream. Property reads are resolved
 * against the target (getters like `columns` must compute on the real TTY), and methods are bound
 * to it so `this` is never the Proxy.
 */
export function createFrameWriter<T extends FrameTarget>(
  target: T,
  opts: { sync?: boolean; onFullClear?: (info: { bytes: number }) => void } = {},
): FrameWriter<T> {
  const sync = opts.sync ?? true;
  const onFullClear = opts.onFullClear;
  let pending: string[] = [];
  let callbacks: Array<() => void> = [];
  let scheduled = false;
  let passthrough = false;

  const flush = (): void => {
    scheduled = false;
    if (pending.length === 0) {
      // Still settle any callbacks that arrived with empty chunks.
      const cbs = callbacks;
      callbacks = [];
      for (const cb of cbs) cb();
      return;
    }
    const body = pending.join("");
    const cbs = callbacks;
    pending = [];
    callbacks = [];
    // Diagnostics (opt-in): flag when Ink took its full-screen-clear branch — the path that can
    // duplicate a tall row into scrollback. Only scans when a probe is attached, so it is free off.
    if (onFullClear && containsInkFullClear(body)) onFullClear({ bytes: body.length });
    target.write(sync ? BEGIN_SYNC + body + END_SYNC : body);
    for (const cb of cbs) cb();
  };

  // Matches the Writable#write overloads Ink and patch-console can reach: (chunk),
  // (chunk, encoding), (chunk, cb), (chunk, encoding, cb).
  const write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | (() => void),
    cb?: () => void,
  ): boolean => {
    const done = typeof encoding === "function" ? encoding : cb;
    const enc = typeof encoding === "string" ? encoding : "utf8";
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(enc);

    if (passthrough) {
      const ok = target.write(text);
      done?.();
      return ok;
    }

    pending.push(text);
    if (done) callbacks.push(done);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
    // We have accepted the chunk into our own buffer, so there is no backpressure to report.
    return true;
  };

  const stream = new Proxy(target, {
    get(t, prop, _receiver) {
      if (prop === "write") return write;
      // Resolve against the target, not the Proxy, so getters (columns/rows) see the real TTY.
      const value = Reflect.get(t, prop, t);
      // A pty that has not been sized yet reports rows/columns as 0 (or undefined) — seen on
      // `script`-allocated ptys and on some ssh/WSL launch paths before the first SIGWINCH. Ink
      // compares `outputHeight >= stdout.rows` to decide whether to full-screen-clear, so rows of
      // 0 makes that ALWAYS true: it clears the screen and reprints the entire static transcript
      // on every single frame. Substituting the same fallbacks Ink and useTerminalRows already
      // assume keeps that check meaningful and keeps the row budget honest.
      if (prop === "rows") return usableDimension(value) ? value : FALLBACK_ROWS;
      if (prop === "columns") return usableDimension(value) ? value : FALLBACK_COLUMNS;
      return typeof value === "function" ? value.bind(t) : value;
    },
  }) as T;

  return {
    stream,
    flush,
    dispose: () => {
      flush();
      passthrough = true;
    },
  };
}
