/**
 * Eased integer value at a point in time during a count-up animation.
 *
 * Uses an ease-out curve (fast then settling) so the counter feels like it
 * "lands" on the final number. Returns whole tokens. Clamps to `to` once the
 * animation is complete (or when `durationMs <= 0`).
 */
export function easedValue(
  from: number,
  to: number,
  elapsedMs: number,
  durationMs: number,
): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return to;
  if (elapsedMs <= 0) return from;
  const t = elapsedMs / durationMs;
  const eased = 1 - (1 - t) * (1 - t); // ease-out quadratic
  return Math.round(from + (to - from) * eased);
}
