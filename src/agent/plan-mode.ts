import type { Tool } from "../tools/types";
import { copiedStatefulControllerRisk } from "./architecture-risk";
import type { RunTurnResult } from "./types";

/** True for tools blocked in plan mode (file mutation / shell execution). */
export function isMutating(tool: Tool): boolean {
  return tool.mutates === true;
}

/** Actionable message returned to the model when it tries a mutating tool in plan mode. */
export function planModeDenial(toolName: string): string {
  return `${toolName} is unavailable in plan mode. Investigate with read-only tools and present your plan in a single final reply; the user will review and approve it before any changes are made.`;
}

/** Synthetic user turn seeded after the user approves a plan, kicking off execution. */
export const PLAN_APPROVAL_MESSAGE =
  "The plan is approved. Plan mode has ended; editing and shell tools are available. " +
  "Implement the approved plan now.";

interface NumberedPlanStep {
  number: number;
  title: string;
}

const MAX_SEEDED_PLAN_STEPS = 24;

function planLines(markdown: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) lines.push(line);
  }
  return lines;
}

function cleanStepTitle(raw: string): string {
  return raw
    .replace(/<br\s*\/?>[\s\S]*$/i, "")
    .replace(/^(?:\*\*|__)/, "")
    .replace(/(?:\*\*|__)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function orderedPlanRun(candidates: NumberedPlanStep[]): string[] {
  let best: string[] = [];
  let current: string[] = [];
  for (const candidate of candidates) {
    if (candidate.number === 1) {
      if (current.length > best.length) best = current;
      current = [candidate.title];
      continue;
    }
    if (current.length > 0 && candidate.number === current.length + 1) {
      current.push(candidate.title);
      continue;
    }
    if (current.length > best.length) best = current;
    current = [];
  }
  if (current.length > best.length) best = current;
  if (best.length < 2 || best.length > MAX_SEEDED_PLAN_STEPS) return [];
  return best;
}

/** Extract the concrete execution steps from an approved Markdown plan. Explicit `Step N`
 * headings win, then numbered headings/bold labels, then a plain top-level numbered sequence,
 * then a numbered first column in a Markdown table. Fenced examples and checkbox verification
 * lists are ignored so they cannot become tracker items. Returning an empty list leaves the model
 * free to author a working list itself. */
export function approvedPlanStepTitles(markdown: string): string[] {
  const lines = planLines(markdown);
  const collect = (pattern: RegExp): NumberedPlanStep[] =>
    lines.flatMap((line) => {
      const match = line.match(pattern);
      if (!match) return [];
      const number = Number.parseInt(match[1]!, 10);
      const title = cleanStepTitle(match[2]!);
      return Number.isFinite(number) && title ? [{ number, title }] : [];
    });

  const explicit = orderedPlanRun(
    collect(
      /^\s{0,3}(?:#{1,6}\s+)?(?:[-*]\s+)?(?:\*\*|__)?Step\s+(\d+)\s*(?:[:.)-]\s*|\s+)(.+?)\s*$/i,
    ),
  );
  if (explicit.length > 0) return explicit;

  const labelled = orderedPlanRun(
    collect(/^\s{0,3}(?:(?:#{1,6}\s+)(?:\*\*|__)?|(?:\*\*|__))(\d+)[.)]\s+(.+?)\s*$/i),
  );
  if (labelled.length > 0) return labelled;

  const plain = orderedPlanRun(collect(/^\s{0,3}(\d+)[.)]\s+(.+?)\s*$/));
  if (plain.length > 0) return plain;

  return orderedPlanRun(
    collect(/^\s*\|\s*(?:\*\*|__)?(\d+)(?:\*\*|__)?\s*\|\s*((?!(?:what|step|task)\s*\|).+?)\s*\|/i),
  );
}

/** Keep shared constraints and the selected step's full body; omit other implementation bodies.
 * Fall back to the approved plan when its shape cannot be matched safely. */
export function selectedPlanStep(prosePlan: string, steps: string[], index: number): string {
  const lines = prosePlan.split(/\r?\n/);
  let fenced = false;
  const candidates = lines
    .map((line, i) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      return !fenced &&
        /^\s{0,3}(?:#{1,6}\s+)?(?:\*\*|__)?(?:Step\s+)?\d+[\s.):|—-]|^\s*\|\s*(?:\*\*)?\d+/i.test(
          line,
        )
        ? i
        : -1;
    })
    .filter((i) => i >= 0);
  const starts = steps.map((title) => candidates.find((i) => lines[i]!.includes(title)) ?? -1);
  if (starts.some((start, i) => start < 0 || (i > 0 && start <= starts[i - 1]!))) return prosePlan;
  return [
    lines.slice(0, starts[0]).join("\n"),
    lines.slice(starts[index], starts[index + 1] ?? lines.length).join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Seed one bounded turn that implements a single plan step. A small executor holding a whole
 * multi-step plan plus a growing transcript loses the thread and stalls; running one step per turn
 * keeps each turn's context small while the on-disk code from earlier steps stays the shared truth.
 * Step titles come from the review the host already parsed, so the prompt names an exact step. */
export function buildPlanStepPrompt(prosePlan: string, steps: string[], index: number): string {
  const stepNumber = index + 1;
  const total = steps.length;
  const completed =
    index === 0
      ? "(none yet — this is the first step)"
      : steps
          .slice(0, index)
          .map((title, i) => `${i + 1}. ${title}`)
          .join("\n");
  const last = index === total - 1;
  // Lead with an imperative "Implement …" so the turn classifies as a coding task. Opening with
  // "You are implementing …" reads as descriptive prose, which the task classifier does not treat
  // as coding — the whole prompt then falls through to the data-artifact path (the embedded plan's
  // "markdown"/"report" wording tips it), which wrongly closes tools mid-build for artifact synthesis.
  return `Implement step ${stepNumber} of ${total} of the approved plan below, and ONLY this step — do not begin any later step. The code from earlier steps is already on disk; read the files you need. Keep the app building and runnable after this step, run the step's own focused verification, then stop.${
    last ? " This is the final step; make sure the app runs end to end before finishing." : ""
  }

Approved plan:
${selectedPlanStep(prosePlan, steps, index)}

Already completed:
${completed}

Now implement step ${stepNumber}: ${steps[index]}`;
}

/** Whole-message affirmatives that count as plan approval when typed in plan mode. */
const APPROVALS = new Set([
  "go",
  "go for it",
  "go ahead",
  "go go go",
  "yes",
  "yep",
  "yeah",
  "do it",
  "make it so",
  "approve",
  "approved",
  "proceed",
  "ship it",
  "send it",
  "lgtm",
  "apply it",
  "apply the patches",
  "apply the plan",
]);

/**
 * True when a message is purely an affirmative approval ("go for it", "yes", "do it", …) carrying
 * no new instruction. In plan mode this lets a typed approval do what the inline approve prompt
 * does (exit plan mode + implement) instead of running another tool-blocked plan turn. Conservative
 * on purpose: a whole-message match after trimming punctuation and light politeness, so
 * "go to the about page" or "apply the dark theme" are NOT treated as approval.
 */
export function looksLikeApproval(text: string): boolean {
  const core = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "") // trailing punctuation
    .replace(/^(ok|okay|sure|alright|cool)\b[,\s]+/, "") // leading politeness
    .replace(/\s+please$/, "") // trailing politeness
    .replace(/\s+/g, " ")
    .trim();
  return APPROVALS.has(core);
}

/** Execution wording that is safe to interpret only when the host is already in plan mode and
 * has an approvable plan in memory or recoverable from history. Keep it separate from generic
 * spec approval: "implement the plan" approves execution, not merely a requirements draft. */
export function looksLikePlanExecutionRequest(text: string): boolean {
  if (looksLikeApproval(text)) return true;
  const core = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/^(ok|okay|sure|alright|cool)\b[,\s]+/, "")
    .replace(/\s+please$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    /^(?:implement|execute|apply)\s+(?:(?:the|this|approved)\s+){0,2}plan$/.test(core) ||
    /^(?:start|begin)\s+(?:the\s+)?implementation$/.test(core)
  );
}

export interface RecoverablePlanContext {
  request: string;
  prosePlan: string;
}

/** Rebuild the ephemeral approval context from durable conversation history after a resume or a
 * missed UI checkpoint. Never recover arbitrary assistant prose as an executable plan. */
export function recoverApprovablePlanContext(
  context: RecoverablePlanContext,
): RecoverablePlanContext | null {
  return isApprovablePlanResult({ assistantText: context.prosePlan }) ? context : null;
}

/** System-prompt fragment injected while in plan mode (prepended ahead of the persona). */
export const PLAN_MODE_PROMPT =
  "PLAN MODE: You are in plan mode. You cannot edit files or run shell commands — those tools " +
  "are disabled. Investigate the codebase using read-only tools (read_file, grep, glob, " +
  "code_search), then write a clear, concrete implementation plan with explicit numbered steps as your final " +
  "message and stop. Do not attempt edits. Ground architecture claims in the files and symbols you actually inspected. " +
  "Before claiming that an event, actor tag, runtime gate, or integration seam is absent, search its direct producer and consumer callsites; if that search is incomplete, label the fact unresolved instead of asserting absence. " +
  "Resolve architectural contradictions rather than " +
  "encoding them as trade-offs: copying a component's hooks, inline state, handlers, or runtime " +
  "logic into a sibling is a behavior fork even when the props match. When presentations must " +
  "behave identically, plan a shared controller/composition seam instead. The user will review " +
  "your plan and approve it before any changes are made.";

/** Plan-mode guidance delivered on the USER turn instead of the system prompt: a prompt-prefix
 *  change invalidates the entire KV cache both directions of a plan↔build toggle (audit F4),
 *  while appended content near the write head is cache-cheap. Enforcement does not depend on
 *  this text — mutating tools are denied at the tool layer (runtime planMode check). */
export const PLAN_MODE_REMINDER = `<system-reminder>${PLAN_MODE_PROMPT}</system-reminder>`;

/** Tool-less prompt used to force a plan out of a model that kept attempting blocked tools. */
export const FORCE_PLAN_SYNTHESIS_PROMPT =
  "You are in plan mode and cannot run tools or edit files. Based on the user's request and what " +
  "you have already gathered, write a clear, concrete, step-by-step implementation plan as your " +
  "final message now. Do not attempt to call tools. Output only the plan.";

/** Re-ground a user reply during the bounded architecture-resolution dialogue. */
export function planRevisionTurnPrompt(text: string): string {
  return `${text}\n\n<system-reminder>You are resolving a previously rejected implementation plan. If the user selected one of the repair options, return the complete revised replacement plan with concrete numbered steps; do not return only a confirmation or verdict. If the user asked a question instead, answer it and keep the decision open.</system-reminder>`;
}

/** Plan approval is a state transition with real side effects, so merely remaining in plan mode
 * is insufficient. Require a clean turn plus plan-shaped prose; never surface "Plan ready" for
 * cancellation, watchdog/budget stops, empty-response notices, or synthesis fallbacks. */
export function isApprovablePlanResult(
  result: Pick<RunTurnResult, "assistantText" | "stoppedReason">,
): boolean {
  if (!isPlanCandidateResult(result)) return false;
  return copiedStatefulControllerRisk(result.assistantText) === null;
}

/** Distinguish a complete replacement implementation plan from discussion, verdicts, and option
 * menus. Only complete candidates may be guarded, persisted, or offered for approval. */
export function isPlanCandidateResult(
  result: Pick<RunTurnResult, "assistantText" | "stoppedReason">,
): boolean {
  if (result.stoppedReason) return false;
  const text = result.assistantText.trim();
  if (text.length < 80) return false;
  if (
    /^(?:\(cancelled\)|stopped:|couldn't produce a plan|the model returned an empty response)/i.test(
      text,
    )
  ) {
    return false;
  }
  const optionHeadings = text.match(/^\s*#{0,4}\s*Option\s+[A-Z0-9]+\b/gim)?.length ?? 0;
  if (optionHeadings >= 2) return false;
  return approvedPlanStepTitles(text).length >= 2;
}
