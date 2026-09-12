/** Pure artifact detection and prompt composition for the host-owned spec workflow. The two
 * checkpoints are keypress pickers in the TUI (spec-draft-prompt, spec-execution-prompt); this
 * module supplies what the model is told and how a choice is weighed against architecture risk. */

import { copiedStatefulControllerRisk } from "./architecture-risk";
import type { RunTurnResult } from "./types";

export interface PendingSpec {
  specPath: string;
}

/** Find the durable artifact produced by an active `/spec` workflow. The workflow flag lives in
 * the host; limiting this helper to edited Markdown paths keeps ordinary prose from fabricating a
 * checkpoint. Custom spec directories remain supported. */
export function writtenSpec(
  result: Pick<RunTurnResult, "assistantText" | "editedPaths">,
): PendingSpec | null {
  const handoff = matchSpecHandoff(result.assistantText);
  if (handoff && result.editedPaths.includes(handoff.specPath)) return handoff;
  const markdown = result.editedPaths.filter((candidate) =>
    candidate.toLowerCase().endsWith(".md"),
  );
  const path =
    markdown.find((candidate) => /(?:^|\/)specs\//i.test(candidate)) ??
    (markdown.length === 1 ? markdown[0] : undefined);
  return path ? { specPath: path } : null;
}

/** A revision reply is bounded to the existing artifact and must end at the execution chooser. */
export function buildSpecRevisionPrompt(specPath: string, correction: string): string {
  return `Apply this one bounded revision pass to the draft specification at \`${specPath}\`:\n\n${correction}\n\nUpdate the specification file only. Do not implement product code. After revising it, briefly summarize the changes and stop; the host will present the execution choices.`;
}

/** A hit requires the anchor, the build choices, and an extractable backtick spec path. `review`
 * remains accepted in old transcripts; new handoffs call the extra pass what it is: plan. */
export function matchSpecHandoff(assistantText: string): { specPath: string } | null {
  const lower = assistantText.toLowerCase();
  if (!lower.includes("want me to build it")) return null;
  if (!((lower.includes("review") || lower.includes("plan")) && lower.includes("go"))) {
    return null;
  }
  // The spec path is the first backtick-delimited token that looks like a spec file path.
  const m = assistantText.match(/`([^`]*\.md)`/);
  if (!m) return null;
  return { specPath: m[1]! };
}

/** Shape the plan for reliable incremental delivery. The executor is often a small local model
 * that will not finish a long horizontal plan in one pass; a walking-skeleton-first, vertical-slice
 * plan means stopping partway still leaves a running app instead of a blank page. */
const PLAN_SHAPE_RULE =
  "Shape the plan for incremental delivery by a limited executor: " +
  "(1) The FIRST step must produce a running, viewable app — a walking skeleton that renders the " +
  "primary route or screen with placeholder data — so a working baseline exists before any feature. " +
  "(2) Every later step is a thin VERTICAL slice that keeps the app running end to end and adds one " +
  "user-visible capability; never a horizontal layer (all the pieces, wired only at the end) that " +
  "leaves the app broken until every step lands. " +
  "(3) Order the steps so that stopping after ANY step still leaves a working, if thinner, app. " +
  "(4) Use at most 5 numbered steps, each touching a small number of files. " +
  "(5) Give each step a cheap, self-contained verification — a build plus one focused behavior " +
  "check — and do not make a step's completion depend on full browser or render evidence. ";

export function buildSpecPlanPrompt(specPath: string, specBody: string): string {
  const architectureRule =
    "Treat copying hooks, inline state, handlers, or runtime logic into a sibling component as " +
    "a behavior fork, regardless of a shared props type. If multiple presentations must preserve " +
    "behavior, the plan must establish a shared controller/composition seam. ";
  return specBody
    ? `Review the already-approved specification below against the current repository. Do not rewrite the product requirements. Produce a concrete, step-by-step implementation plan that resolves code seams, ordering, and verification. ${PLAN_SHAPE_RULE}${architectureRule}\n\nSpec path: ${specPath}\n\n${specBody}`
    : `Read the approved spec at \`${specPath}\`, inspect the current repository, and produce a concrete, step-by-step implementation plan. ${PLAN_SHAPE_RULE}${architectureRule}Do not implement it yet.`;
}

/** A contradictory spec must pass through architectural review before either execution path. */
export function specRequiresArchitectureReview(specBody: string): string | null {
  return copiedStatefulControllerRisk(specBody);
}

export function composeReviewedSpecPlan(
  specPath: string,
  specBody: string,
  review: string,
): string {
  const source = specBody || `Approved spec path: ${specPath}`;
  return `Approved source specification:\n${source}\n\nPlan-mode implementation review:\n${review}`;
}

export type SpecExecutionAction =
  | { kind: "orchestrate-plan" }
  | { kind: "orchestrate" }
  | { kind: "plan" }
  | { kind: "direct"; guardrail: string | null };

/** `plan` always plans; `orchestrate` forces one planning pass first when a structural seam
 * remains (workers decompose the spec, so the seam must be settled before any worker starts); an
 * explicit `go` is honored as a direct build — an architecture risk is carried into that build as a
 * guardrail rather than silently rerouting the user into a planning pass they did not ask for. */
export function resolveSpecExecutionAction(
  choice: "orchestrate" | "plan" | "go",
  architectureRisk: string | null,
): SpecExecutionAction {
  if (choice === "plan") return { kind: "plan" };
  if (choice === "orchestrate") {
    return architectureRisk ? { kind: "orchestrate-plan" } : { kind: "orchestrate" };
  }
  return { kind: "direct", guardrail: architectureRisk };
}

/** Fold an architecture guardrail into a direct-build objective so a honored `go` still warns the
 * model about the seam the forced review would otherwise have caught. Returns the bare objective
 * when there is no risk. */
export function buildDirectBuildObjective(
  objective: string,
  architectureRisk: string | null,
): string {
  if (!architectureRisk) return objective;
  return `${objective}\n\n<system-reminder>Architecture guardrail before you build: ${architectureRisk} Treat copying hooks, inline state, handlers, or runtime logic into a sibling component as a behavior fork even when a props type is shared; establish one shared controller/composition seam instead of duplicating behavior.</system-reminder>`;
}
