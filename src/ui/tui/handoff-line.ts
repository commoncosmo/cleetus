import type { Actor } from "../../events/types";

/** The subset of a worker `user_input` payload the handoff line reads. */
export interface HandoffPayload {
  text: string;
  source?: string;
  title?: string;
}

/**
 * Render a down-passed subagent instruction as a one-line orchestrator→worker handoff, e.g.
 * "↳ Task 17 → worker: Verify API Routes (14 lines)". The full instruction text is NOT shown
 * (it lives in the event log); the line count is the size hint for what was collapsed.
 *
 * - Task number: parsed from a `t<number>` actor.taskId; omitted for non-numeric ids (e.g. the
 *   integration "fix-config" tasks) → "↳ worker: Fix: … (N lines)".
 * - Title: omitted (no ": title") when payload.title is absent.
 * - Line count: payload.text split on "\n" (the whole handed-down prompt, brief included).
 */
export function formatHandoffLine(payload: HandoffPayload, actor: Actor): string {
  const lines = payload.text.length === 0 ? 0 : payload.text.split("\n").length;
  const m = actor.taskId?.match(/^t(\d+)$/);
  const taskPart = m ? `Task ${m[1]} → ` : "";
  const titlePart = payload.title ? `: ${payload.title}` : "";
  const plural = lines === 1 ? "line" : "lines";
  return `↳ ${taskPart}${actor.role}${titlePart} (${lines} ${plural})`;
}
