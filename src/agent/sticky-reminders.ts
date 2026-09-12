/** Result of folding the current turn's triggered reminders into the sticky arc. */
export interface StickyResult {
  /** The arc state to persist for this session after this turn. */
  arc: string[];
  /** The reminder strings to append to this turn's content (deduped). */
  inject: string[];
}

/**
 * Compute the sticky skill reminders for a turn.
 *
 * The "arc" is the set of skill reminders accumulated while a plan is being drafted; it persists
 * after plan mode exits so a skill triggered on the plan-request turn (e.g. TDD) is re-injected on
 * the approval + implementation turns that actually write the code — the plan → approve → implement
 * arc. Pure and skill-agnostic: it works on rendered reminder strings.
 *
 * - Entering plan mode (`planNow && !wasPlan`) drops the previous arc, so each plan starts clean.
 * - The arc accumulates ONLY while `planNow`, which bounds stickiness to plan mode: a skill
 *   triggered directly outside plan mode is injected for that turn but is not made sticky.
 * - Outside plan mode the arc is frozen and replayed, covering the approval turn and follow-ups.
 * - Dedupe is by string identity; `renderSkillReminder(skill)` is deterministic.
 */
export function stickyReminders(
  current: string[],
  planNow: boolean,
  wasPlan: boolean,
  arc: string[],
): StickyResult {
  let next = arc;
  if (planNow && !wasPlan) next = [];
  if (planNow) next = [...new Set([...next, ...current])];
  const inject = [...new Set([...current, ...next])];
  return { arc: next, inject };
}
