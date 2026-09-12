import { useEffect, useRef, useState } from "react";
import { easedValue } from "./count-up";
import { FRAME_MS, subscribeFrameClock } from "./frame-clock";

/**
 * Animate a displayed integer up to `target` whenever `target` changes.
 *
 * On first render the displayed value starts AT `target` (no animate-from-zero
 * when a session already has history). When `target` changes, the animation
 * re-bases from the currently displayed value so motion stays continuous even
 * if several model calls land in quick succession.
 */
export function useCountUp(target: number, durationMs = 400): number {
  const [display, setDisplay] = useState(target);
  // Latest displayed value, readable synchronously when (re)basing.
  const displayRef = useRef(target);
  displayRef.current = display;

  useEffect(() => {
    // Read the live displayed value from the ref (not the `display` state) so the
    // effect re-runs only when `target` changes — each frame's setDisplay must not
    // restart the animation. `from` re-bases on the current display, keeping motion
    // continuous when several model calls land in quick succession.
    const from = displayRef.current;
    if (from === target) return;

    const start = Date.now();
    // Rides the shared frame clock so the counter animates on the same beat as everything else.
    // `stop` is called from inside the callback once the ease completes, which the clock allows.
    const stop = subscribeFrameClock(FRAME_MS, () => {
      const elapsed = Date.now() - start;
      setDisplay(easedValue(from, target, elapsed, durationMs));
      if (elapsed >= durationMs) stop();
    });

    return stop;
  }, [target, durationMs]);

  return display;
}
