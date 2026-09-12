/**
 * Single-slot input queue (FINDINGS Finding 9).
 *
 * While the agent is busy, Enter routes here instead of handleSubmit. The
 * slot is delivered through the normal submit router at the next idle
 * boundary — unless a choice prompt is pending or the turn was aborted, in
 * which case the text drops back into the input buffer, editable and
 * unsent. It must never be silently dropped and never auto-sent where it
 * would be misread as a reply.
 */

export type BoundaryAction = "deliver" | "prefill" | "none";

/** Append `text` to the slot; a second Enter never replaces the first. */
export function enqueue(slot: string | null, text: string): string {
  return slot == null || slot === "" ? text : `${slot}\n${text}`;
}

export function resolveBoundary(s: {
  queued: string | null;
  aborted: boolean;
  hasPendingPrompt: boolean;
}): BoundaryAction {
  if (s.queued == null || s.queued === "") return "none";
  // An aborted turn pre-fills even though the Esc handler normally drains
  // the slot before aborting — belt for any abort source that bypassed it.
  if (s.aborted || s.hasPendingPrompt) return "prefill";
  return "deliver";
}

/** One-line rendering of the slot for the queued indicator. */
export function queuedLine(queued: string): string {
  const nl = queued.indexOf("\n");
  return nl === -1 ? queued : `${queued.slice(0, nl)} …`;
}

/** Queued text first (it is older), then whatever was mid-typing. */
export function joinForPrefill(queued: string, buffer: string): string {
  return buffer.trim() === "" ? queued : `${queued}\n${buffer}`;
}
