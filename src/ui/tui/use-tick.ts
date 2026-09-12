import { useEffect, useState } from "react";
import { subscribeFrameClock } from "./frame-clock";

/**
 * Force a re-render every `intervalMs` while mounted and `active`. The subscription is dropped on
 * unmount and whenever `active` goes false, so a component that stays mounted across an idle TUI
 * (the todo tracker) incurs no timer cost between turns.
 *
 * `intervalMs` is a request, not a guarantee: it is rounded to the shared frame grid so every
 * animation in the TUI advances on the same beat. See ./frame-clock.
 */
export function useTick(intervalMs: number, active = true): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    return subscribeFrameClock(intervalMs, () => setTick((t) => t + 1));
  }, [intervalMs, active]);
}
