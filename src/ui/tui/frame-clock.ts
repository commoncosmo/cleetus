/**
 * One shared animation clock for the whole TUI.
 *
 * The TUI used to run five independent timers — the busy spinner (80ms), the reasoning spinner
 * (120ms), the token count-up (50ms), the live-stream flush (50ms) and the todo elapsed clock
 * (1000ms). Each one independently re-rendered the tree, so their beats interleaved against each
 * other and against Ink's own 32ms render throttle. The result is frames at irregular intervals,
 * which reads as flicker even when every individual frame is drawn correctly — and on WSL2, where
 * each frame is expensive, it is the difference between "animated" and "jittery".
 *
 * Everything now advances on one interval, so a tick produces at most one frame no matter how many
 * widgets are animating, and the interval between frames is constant. Subscribers that want a
 * slower cadence get every Nth tick rather than a timer of their own; because they are counted off
 * the same frame number, a 1s clock and a 100ms spinner stay phase-aligned instead of drifting.
 *
 * FRAME_MS is 100 (10fps) deliberately: it divides the 1s todo clock exactly, and it is slow enough
 * that a WSL2 terminal comfortably keeps up.
 */

/** The one true tick interval. All animation cadences are multiples of this. */
export const FRAME_MS = 100;

/** How many clock frames a requested interval rounds to; never less than one. Pure. */
export function framesFor(intervalMs: number): number {
  return Math.max(1, Math.round(intervalMs / FRAME_MS));
}

interface Subscriber {
  periodFrames: number;
  fn: () => void;
}

const subscribers = new Set<Subscriber>();
let timer: ReturnType<typeof setInterval> | null = null;
let frame = 0;

function tick(): void {
  frame++;
  // Copy first: a subscriber may unsubscribe (or mount another) from inside its own callback.
  for (const sub of [...subscribers]) {
    if (frame % sub.periodFrames === 0) sub.fn();
  }
}

/**
 * Run `fn` every `intervalMs` (rounded to the frame grid) until the returned disposer is called.
 * The underlying interval exists only while at least one subscriber is registered, so an idle TUI
 * does no timer work at all.
 */
export function subscribeFrameClock(intervalMs: number, fn: () => void): () => void {
  const sub: Subscriber = { periodFrames: framesFor(intervalMs), fn };
  subscribers.add(sub);
  if (timer === null) {
    frame = 0;
    timer = setInterval(tick, FRAME_MS);
    // Never hold the process open on the animation clock alone; Ink owns the lifetime.
    (timer as { unref?: () => void }).unref?.();
  }
  return () => {
    subscribers.delete(sub);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Test seam: drive the clock by hand. Returns the frame number that was just delivered. */
export function advanceFrameClockForTest(frames = 1): number {
  for (let i = 0; i < frames; i++) tick();
  return frame;
}

/** Test seam: drop all subscribers and stop the interval. */
export function resetFrameClockForTest(): void {
  subscribers.clear();
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  frame = 0;
}
