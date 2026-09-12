import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { BootstrapLocation } from "./bootstrap-location";
import type { OrchestrationPlan, PlanTask } from "./orchestrator";

export type ExecutionStrategy = "single" | "hybrid" | "orchestrated";
export type AdmissionExecutionChoice = "single" | "workers";

/** Hybrid is advisory until a staged lead-then-leaves executor exists; use the safer coherent
 * single-agent path rather than silently treating today's all-worker executor as hybrid. */
export function recommendedAdmissionChoice(strategy: ExecutionStrategy): AdmissionExecutionChoice {
  return strategy === "orchestrated" ? "workers" : "single";
}

export function admissionChoicePayload(
  report: OrchestrationAdmissionReport,
  choice: AdmissionExecutionChoice,
) {
  const recommended = recommendedAdmissionChoice(report.strategy);
  return {
    text: `Execution choice: ${choice === "workers" ? "orchestrated workers" : "single agent"}${choice === recommended ? " (recommended)" : ` (overrode ${report.strategy} recommendation)`}.`,
    kind: "orchestration_admission_choice",
    strategy: report.strategy,
    choice,
    recommended,
    overridden: choice !== recommended,
    confidence: report.confidence,
    score: report.score,
    reasons: report.reasons,
    risks: report.risks,
    facts: report.facts,
  };
}

export interface OrchestrationAdmissionFacts {
  implementationTasks: number;
  exploreTasks: number;
  tasksWithFocusedAcceptance: number;
  tasksWithoutNamedFiles: number;
  referencedFiles: string[];
  sharedFiles: string[];
  largeSharedFiles: string[];
  subjectiveVisualWork: boolean;
  unresolvedArchitecture: boolean;
  stagedDiscovery: boolean;
  mechanicalWork: boolean;
}

export interface OrchestrationAdmissionReport {
  strategy: ExecutionStrategy;
  confidence: number;
  score: number;
  summary: string;
  reasons: string[];
  risks: string[];
  facts: OrchestrationAdmissionFacts;
}

const SOURCE_PATH =
  /(?:^|[\s`'"(])([A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+-]+)*\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|rb|php|vue|svelte|css|scss|html|json|ya?ml|toml|md))(?![A-Za-z0-9_])/g;
const FOCUSED_COMMAND =
  /\b(?:bun\s+test\s+\S+|pytest\s+\S+|cargo\s+test\s+\S+|go\s+test\s+\S+|swift\s+test\s+--filter\s+\S+)/i;
const BROAD_GATE =
  /\b(?:full|entire|all|repository[- ]wide|repo[- ]wide)\s+(?:test\s+)?suite\b|\bbun\s+test\s*$|\b(?:lint|typecheck|build)\s+(?:passes|succeeds|cleanly)\b/i;
const VISUAL =
  /\b(?:tui|ui|ux|visual|layout|theme|styling|design|dashboard|screen|responsive|animation)\b/i;
const SUBJECTIVE =
  /\b(?:beautiful|polished|modern|great|good-looking|attractive|intuitive|delightful|redesign|reskin|look and feel)\b/i;
// Keep this architecture-specific. A bare `unknown` is often an ordinary product requirement
// (for example, "ignore unknown events") and must not downgrade an otherwise separable plan.
const UNRESOLVED =
  /\b(?:determine whether|figure out|investigate|root cause|explore architecture|decide (?:how|whether)|open question|tbd)\b|\b(?:architecture|implementation|repository|codebase|seam|ownership|approach)\s+(?:is|remains|are|remain)\s+(?:unknown|unclear|unresolved)\b/i;
const EVIDENCE_UNRESOLVED =
  /\bneed(?:s)? to (?:inspect|verify|confirm|determine)\s+(?:the\s+)?(?:actual|whether|if|which|where|how)\b|\bevent (?:payload|shape|source) assumptions?\b/i;
const MECHANICAL =
  /\b(?:migrate|rename|move files?|codemod|adapter|provider|backfill|generated?|repeat(?:ed|able)?|one per|each (?:module|package|endpoint))\b/i;

function taskText(task: PlanTask): string {
  return [task.title, task.description, ...(task.acceptanceCriteria ?? [])].join("\n");
}

/** Approved prose remains relevant when it explicitly says a repository fact still needs to be
 * established. Strip clauses that merely mention already-resolved questions, then look for
 * concrete evidence gaps. This catches plans that present disjoint leaves while admitting that
 * none of them knows the producer payloads they must interpret. */
export function approvedPlanHasUnresolvedEvidence(text: string): boolean {
  const unresolvedText = text.replace(
    /\b(?:resolved|answered|closed)\b[^.\n]{0,80}\bopen questions?\b[^.\n]*/gi,
    "",
  );
  return UNRESOLVED.test(unresolvedText) || EVIDENCE_UNRESOLVED.test(unresolvedText);
}

/** Extract only explicit source/config/document paths from plan text. This deliberately avoids a
 * repository crawl: admission should be cheap and should not become another exploration phase. */
export function namedTaskFiles(task: PlanTask): string[] {
  const found = new Set<string>();
  const text = taskText(task);
  for (const match of text.matchAll(SOURCE_PATH)) {
    const path = match[1]?.replace(/^\.\//, "");
    if (path) found.add(path);
  }
  return [...found];
}

export function hasFocusedAcceptance(task: PlanTask): boolean {
  const acceptance = (task.acceptanceCriteria ?? []).join("\n").trim();
  if (!acceptance || BROAD_GATE.test(acceptance)) return false;
  return (
    FOCUSED_COMMAND.test(acceptance) ||
    /\b(?:assert|expect|snapshot|renders?|interaction|round[- ]trip|counts?|classifies?|detects?|formats?|groups?|handles?|ignores?|parses?|preserves?)\b/i.test(
      acceptance,
    )
  );
}

function projectRoot(projectDir: string, location: BootstrapLocation): string {
  return location.kind === "subdir" ? resolve(projectDir, location.name) : resolve(projectDir);
}

async function lineCountWithin(root: string, path: string): Promise<number | null> {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    const info = await stat(absolute);
    if (!info.isFile() || info.size > 1_000_000) return null;
    const body = await readFile(absolute, "utf8");
    return body.length === 0 ? 0 : body.split("\n").length;
  } catch {
    return null;
  }
}

export interface RecommendStrategyInput {
  facts: OrchestrationAdmissionFacts;
}

/** Pure scoring core. Hard-to-reverse coupling signals outweigh task count: several workers
 * editing one monolith are not independent just because the planner emitted several tasks. */
export function recommendExecutionStrategy(
  input: RecommendStrategyInput,
): OrchestrationAdmissionReport {
  const f = input.facts;
  let score = 0;
  const reasons: string[] = [];
  const risks: string[] = [];

  if (f.implementationTasks >= 3) {
    score += 2;
    reasons.push(
      `${f.implementationTasks} implementation tasks provide potential worker-sized units`,
    );
  } else {
    score -= 2;
    risks.push(
      `only ${f.implementationTasks} implementation task${f.implementationTasks === 1 ? "" : "s"}`,
    );
  }
  if (f.referencedFiles.length >= f.implementationTasks && f.sharedFiles.length === 0) {
    score += 2;
    reasons.push("the plan names disjoint files across tasks");
  }
  if (f.tasksWithFocusedAcceptance >= Math.max(1, Math.ceil(f.implementationTasks * 0.75))) {
    score += 2;
    reasons.push("most implementation tasks have focused acceptance evidence");
  } else {
    score -= 1;
    risks.push("too few tasks have focused, behavior-level acceptance evidence");
  }
  if (f.mechanicalWork) {
    score += 1;
    reasons.push("the request contains repeated or mechanical implementation work");
  }
  if (f.sharedFiles.length > 0) {
    score -= 3;
    risks.push(
      `${f.sharedFiles.length} file${f.sharedFiles.length === 1 ? " is" : "s are"} owned by multiple tasks`,
    );
  }
  if (f.largeSharedFiles.length > 0) {
    score -= 2;
    risks.push(`shared large file: ${f.largeSharedFiles.slice(0, 2).join(", ")}`);
  }
  if (f.tasksWithoutNamedFiles > Math.floor(f.implementationTasks / 2)) {
    score -= 1;
    risks.push("most implementation tasks do not identify their file ownership");
  }
  if (f.stagedDiscovery) {
    score += 1;
    reasons.push("one bounded discovery task is ordered before disjoint implementation leaves");
  } else if (f.exploreTasks > 0 || f.unresolvedArchitecture) {
    score -= 2;
    risks.push("architecture or repository facts remain unresolved");
  }
  if (f.subjectiveVisualWork) {
    score -= 2;
    risks.push("subjective visual quality benefits from one coherent implementation pass");
  }

  let strategy: ExecutionStrategy;
  if (f.implementationTasks <= 1 || score <= -2) strategy = "single";
  else if (score >= 4) strategy = "orchestrated";
  else strategy = "hybrid";
  // Unresolved architecture is a sequencing constraint, not merely a small score penalty. Even a
  // clean-looking set of downstream leaves should wait for one lead to establish the seam.
  if (
    strategy === "orchestrated" &&
    !f.stagedDiscovery &&
    (f.exploreTasks > 0 || f.unresolvedArchitecture)
  ) {
    strategy = "hybrid";
  }

  const confidence = Math.min(0.95, 0.62 + Math.min(0.28, Math.abs(score) * 0.045));
  const summary =
    strategy === "orchestrated"
      ? "Orchestration looks worthwhile: the plan is sufficiently separable and testable."
      : strategy === "hybrid"
        ? "Hybrid execution is safer: land the shared or architectural seam with one strong agent, then delegate independent leaves."
        : "A single agent is recommended: handoff and integration risk outweigh likely parallelism or token savings.";

  return { strategy, confidence, score, summary, reasons, risks, facts: f };
}

/** Analyze a structured plan and only the files explicitly named by it. No recursive walk and no
 * model call: runtime stays predictable even for very large repositories. */
export async function analyzeOrchestrationAdmission(input: {
  plan: OrchestrationPlan;
  projectDir: string;
}): Promise<OrchestrationAdmissionReport> {
  const implementation = input.plan.tasks.filter((task) => task.agentType !== "explore");
  const exploreTasks = input.plan.tasks.length - implementation.length;
  const ownership = new Map<string, number>();
  let tasksWithoutNamedFiles = 0;
  let tasksWithFocusedAcceptance = 0;
  for (const task of implementation) {
    const files = namedTaskFiles(task);
    if (files.length === 0) tasksWithoutNamedFiles++;
    if (hasFocusedAcceptance(task)) tasksWithFocusedAcceptance++;
    for (const file of files) ownership.set(file, (ownership.get(file) ?? 0) + 1);
  }
  const referencedFiles = [...ownership.keys()].sort();
  const sharedFiles = referencedFiles.filter((file) => (ownership.get(file) ?? 0) > 1);
  const root = projectRoot(input.projectDir, input.plan.location);
  const largeSharedFiles: string[] = [];
  for (const file of sharedFiles.slice(0, 12)) {
    const lines = await lineCountWithin(root, file);
    if (lines !== null && lines >= 500) largeSharedFiles.push(`${file} (${lines} lines)`);
  }
  const taskTexts = input.plan.tasks.map(taskText);
  const allText = [input.plan.objective, input.plan.approvedPlan ?? "", ...taskTexts].join("\n");
  // The task list is primary, but an approved plan's explicit unresolved evidence cannot be
  // discarded merely because the decomposer omitted discovery from its JSON leaves.
  const unresolvedArchitecture =
    taskTexts.some((text) => UNRESOLVED.test(text) || EVIDENCE_UNRESOLVED.test(text)) ||
    approvedPlanHasUnresolvedEvidence(input.plan.approvedPlan ?? "");
  const stagedDiscovery =
    input.plan.tasks[0]?.agentType === "explore" &&
    exploreTasks === 1 &&
    implementation.length >= 3 &&
    sharedFiles.length === 0 &&
    tasksWithoutNamedFiles <= Math.floor(implementation.length / 2);
  const facts: OrchestrationAdmissionFacts = {
    implementationTasks: implementation.length,
    exploreTasks,
    tasksWithFocusedAcceptance,
    tasksWithoutNamedFiles,
    referencedFiles,
    sharedFiles,
    largeSharedFiles,
    subjectiveVisualWork: VISUAL.test(allText) && SUBJECTIVE.test(allText),
    unresolvedArchitecture,
    stagedDiscovery,
    mechanicalWork: MECHANICAL.test(allText),
  };
  return recommendExecutionStrategy({ facts });
}

export function renderAdmissionReport(report: OrchestrationAdmissionReport): string {
  const label =
    report.strategy === "hybrid"
      ? "single agent (hybrid staging unavailable)"
      : report.strategy === "single"
        ? "single agent"
        : "orchestrated workers";
  const summary =
    report.strategy === "hybrid"
      ? "This plan has a hybrid shape, but Cleetus cannot yet run a staged lead-then-workers path. Use the recommended single agent for coherence, or explicitly force all workers."
      : report.summary;
  const evidence = [...report.reasons.slice(0, 2), ...report.risks.slice(0, 3)]
    .map((item) => `- ${item}`)
    .join("\n");
  return `Execution recommendation: ${label} (${Math.round(report.confidence * 100)}% confidence)\n${summary}${evidence ? `\n${evidence}` : ""}`;
}
