import { z } from "zod";
import type { OrchestrationConfig } from "../config/orchestration";
import type { EventInput } from "../events/types";
import {
  type BootstrapLocation,
  describeOnDisk,
  isFreshBootstrap,
  renderLocationAnchor,
  resolveBuildDir,
  snapshotProjectMarkers,
} from "./bootstrap-location";
import type { BuildGateResult } from "./build-gate/gate";
import type { Violation } from "./config-doctor";
import {
  CLOSING_SYSTEM,
  REPLAN_SYSTEM,
  STRUCTURE_SYSTEM,
  closingUser,
  replanUser,
  structureUser,
  withSkillGuidance,
  withUserInstructions,
} from "./orchestrator-prompts";
import { isVerificationOnlyTitle } from "./scope-guard";
import type { SpawnWorker } from "./subagent";
import type { VerificationResult } from "./types";

export type SubagentKind = "general" | "explore" | "review";
export type TaskStatus = "pending" | "running" | "done" | "partial" | "failed";

export interface PlanTask {
  id: string; // e.g. "t1" — cosmetic / for notices; position drives the loop
  title: string;
  description: string;
  agentType: SubagentKind;
  status: TaskStatus;
  /** Checkable outcomes authored with the approved plan and carried through replans/workers. */
  acceptanceCriteria?: string[];
  /** Project-relative files this task produced (written/edited), captured on completion. Fed into
   *  later workers' "Already done" digest so a dependent task can locate a prior task's artifacts
   *  instead of hunting the filesystem. */
  producedFiles?: string[];
  /** Bounded worker result retained when files alone cannot carry the handoff (especially
   *  read-only exploration). Fresh workers otherwise repeat the same repository inventory. */
  resultSummary?: string;
}

const TASK_PATH_PATTERN =
  /(?:^|[\s`'"(])([A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+-]+)*\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|rb|php|vue|svelte|css|scss|html|json|ya?ml|toml|md|lock))(?![A-Za-z0-9_])/g;

/** Explicit file ownership carried in a structured task's description and acceptance criteria. */
export function taskOwnedPaths(task: PlanTask): string[] {
  const found = new Set<string>();
  const text = [task.description, ...(task.acceptanceCriteria ?? [])].join("\n");
  for (const match of text.matchAll(TASK_PATH_PATTERN)) {
    const path = match[1]?.replace(/^\.\//, "");
    if (path) found.add(path);
  }
  return [...found];
}

export interface TaskOutcomeEntry {
  title: string;
  status: Extract<TaskStatus, "done" | "partial" | "failed">;
  files: string[];
  summary?: string;
  /** Constraints established by this task that later workers must preserve. */
  acceptance?: string[];
}

const TASK_HANDOFF_CHARS = 6000;
const TOTAL_HANDOFF_CHARS = 12000;

/** Keep both the beginning and conclusion of a verbose worker result: exploration inventories
 *  usually establish context first and put the most actionable signatures/conclusions last. */
export function boundTaskHandoff(text: string, limit = TASK_HANDOFF_CHARS): string {
  const clean = text.trim();
  if (limit <= 32) return clean.slice(0, Math.max(0, limit));
  if (clean.length <= limit) return clean;
  const head = Math.floor((limit - 32) / 2);
  const tail = limit - 32 - head;
  return `${clean.slice(0, head)}\n...[handoff truncated]...\n${clean.slice(-tail)}`;
}

export interface SemanticCheck {
  requirement: string;
  status: "pass" | "fail";
  evidence: string;
  repair?: string;
}

export interface SemanticReport {
  verdict: "pass" | "fail";
  summary: string;
  checks: SemanticCheck[];
}

/** A plan as produced by the model/parser — brief + tasks, no scope anchor yet. */
export interface ParsedPlan {
  brief: string;
  tasks: PlanTask[];
}

/** An executable plan: a parsed plan plus the immutable user objective. `objective` is the
 *  user's original request, frozen at structuring time — the scope boundary replans anchor to.
 *  The model never supplies it, so no replan can rewrite it. */
export interface OrchestrationPlan extends ParsedPlan {
  objective: string;
  location: BootstrapLocation;
  /** Original approved prose retained for the final semantic integration pass. */
  approvedPlan?: string;
}

const RawTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  agent_type: z.enum(["general", "explore"]).optional(),
  acceptance: z.array(z.string().min(1)).optional(),
});

const RawPlanSchema = z.object({
  brief: z.string().optional(),
  tasks: z.array(RawTaskSchema),
});

const SemanticReportSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  summary: z.string().min(1),
  checks: z
    .array(
      z.object({
        requirement: z.string().min(1),
        status: z.enum(["pass", "fail"]),
        evidence: z.string().min(1),
        // Some otherwise-correct verifiers serialize an omitted optional field as an empty
        // string. Treat blank repair text as absent so a formatting quirk cannot discard real
        // failed checks and trigger a second verifier that starts from a clean slate.
        repair: z.preprocess(
          (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
          z.string().min(1).optional(),
        ),
      }),
    )
    .min(1),
});

/**
 * Extract the first JSON object. A ```json fence (when present) only anchors WHERE the object
 * starts — guarding against stray braces in any preamble — after which a balanced-brace scan finds
 * the matching close. The fence is deliberately NOT used to find the END: planners routinely embed
 * ``` code fences inside task-description strings, so a non-greedy fence match would stop at the
 * first inner ``` and truncate the JSON. The brace scanner respects string/escape state, so braces
 * and backticks inside string values can't end the object early.
 */
function extractJsonBlock(text: string): string | null {
  const fence = text.match(/```(?:json)?/i);
  const from = fence ? fence.index! + fence[0].length : 0;
  const start = text.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse the strong verifier's evidence-backed semantic report. A report cannot claim an overall
 * pass while carrying failed checks; normalize that contradiction to fail. */
export function parseSemanticReport(text: string): SemanticReport | null {
  const block = extractJsonBlock(text);
  if (!block) return null;
  try {
    const parsed = SemanticReportSchema.safeParse(JSON.parse(block));
    if (!parsed.success) return null;
    const verdict = parsed.data.checks.some((check) => check.status === "fail")
      ? "fail"
      : parsed.data.verdict;
    return { ...parsed.data, verdict };
  } catch {
    return null;
  }
}

function failedSemanticChecks(report: SemanticReport): SemanticCheck[] {
  return report.checks.filter((check) => check.status === "fail");
}

function renderSemanticReport(report: SemanticReport): string {
  const checks = report.checks
    .map(
      (check) =>
        `- [${check.status}] ${check.requirement}: ${check.evidence}${check.repair ? ` Repair: ${check.repair}` : ""}`,
    )
    .join("\n");
  return `${report.summary}\n${checks}`;
}

/** Renumber task ids sequentially from `offset`, forcing pending status. Pure. */
export function reindex(tasks: PlanTask[], offset: number): PlanTask[] {
  return tasks.map((t, i) => ({ ...t, id: `t${offset + i + 1}`, status: "pending" as const }));
}

/** Collapse retry/re-run duplicates in the done list: entries whose title matches after stripping a
 *  leading "Retry: " prefix and normalizing case/space are merged, unioning their files (first
 *  occurrence's display title wins). Preserves first-seen order. Pure. */
export function dedupeDoneEntries(entries: TaskOutcomeEntry[]): TaskOutcomeEntry[] {
  const norm = (t: string) =>
    t
      .replace(/^retry:\s*/i, "")
      .trim()
      .toLowerCase();
  const byKey = new Map<string, TaskOutcomeEntry>();
  const order: string[] = [];
  for (const e of entries) {
    const k = norm(e.title);
    const existing = byKey.get(k);
    if (existing) {
      for (const f of e.files) if (!existing.files.includes(f)) existing.files.push(f);
      // Entries are chronological. The latest retry determines whether the logical task is now
      // complete, while the unioned file list retains artifacts from every attempt.
      existing.status = e.status;
      if (e.summary) existing.summary = e.summary;
      if (e.acceptance?.length) {
        existing.acceptance = [...new Set([...(existing.acceptance ?? []), ...e.acceptance])];
      }
    } else {
      byKey.set(k, {
        title: e.title.replace(/^retry:\s*/i, "").trim(),
        status: e.status,
        files: [...e.files],
        ...(e.summary ? { summary: e.summary } : {}),
        ...(e.acceptance?.length ? { acceptance: e.acceptance } : {}),
      });
      order.push(k);
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/** ` → a, b (+N more)` for a produced-file list (first 6 + overflow), or `""` when empty. Pure. */
function fileSuffix(files: string[]): string {
  if (files.length === 0) return "";
  const shown = files.slice(0, 6).join(", ");
  const extra = files.length > 6 ? ` (+${files.length - 6} more)` : "";
  return ` → ${shown}${extra}`;
}

function taskOutcomeEntries(tasks: PlanTask[]): TaskOutcomeEntry[] {
  return tasks.map((task) => ({
    title: task.title,
    status: task.status === "done" ? "done" : task.status === "partial" ? "partial" : "failed",
    files: task.producedFiles ?? [],
    summary: task.resultSummary,
    acceptance: task.acceptanceCriteria,
  }));
}

/** Assemble a coordinated worker prompt: directory/scaffold anchor, a "what's already done" digest
 *  (completed task titles + on-disk snapshot), the task itself framed as do-ONLY-this, the upcoming
 *  tasks framed as not-your-job, and the project brief. Empty sections are omitted. Pure. */
export function composeWorkerPrompt(input: {
  anchor: string;
  onDiskSnapshot: string;
  doneEntries: TaskOutcomeEntry[];
  taskDescription: string;
  upcomingTitles: string[];
  brief: string;
}): string {
  const parts: string[] = [];
  if (input.anchor) parts.push(input.anchor);
  const done = dedupeDoneEntries(input.doneEntries);
  if (done.length > 0) {
    const marker = (status: TaskOutcomeEntry["status"]) =>
      status === "done" ? "✓" : status === "partial" ? "◐" : "✗";
    const suffix = (status: TaskOutcomeEntry["status"]) =>
      status === "partial"
        ? " (partial — inspect before continuing)"
        : status === "failed"
          ? " (failed)"
          : "";
    let handoffChars = 0;
    const lines = done
      .map((e) => {
        const line = ` ${marker(e.status)} ${e.title}${fileSuffix(e.files)}${suffix(e.status)}`;
        const acceptance = e.acceptance?.length
          ? `\n   Preserve these established constraints:\n${e.acceptance
              .map((criterion) => `   - ${criterion}`)
              .join("\n")}`
          : "";
        if (!e.summary || handoffChars >= TOTAL_HANDOFF_CHARS) return `${line}${acceptance}`;
        const remaining = TOTAL_HANDOFF_CHARS - handoffChars;
        const handoff = boundTaskHandoff(e.summary, Math.min(TASK_HANDOFF_CHARS, remaining));
        handoffChars += handoff.length;
        return `${line}${acceptance}\n   Handoff:\n${handoff
          .split("\n")
          .map((part) => `   ${part}`)
          .join("\n")}`;
      })
      .join("\n");
    const snap = input.onDiskSnapshot ? `\n${input.onDiskSnapshot}` : "";
    parts.push(`## Prior task outcomes\n${lines}${snap}`);
  } else if (input.onDiskSnapshot) {
    parts.push(input.onDiskSnapshot);
  }
  parts.push(`## Your task (do ONLY this)\n${input.taskDescription}`);
  if (input.upcomingTitles.length > 0) {
    parts.push(`## Upcoming (NOT your job): ${input.upcomingTitles.join("; ")}`);
  }
  parts.push(`## Project brief\n${input.brief}`);
  return parts.join("\n\n");
}

/** Deterministic first-person outcome block for the main-conversation writeback: a ✓/✗ line per
 *  executed task (✓ with its produced files, ✗ for incomplete) plus a tally. Built from task
 *  status + producedFiles — NOT the orchestrator model's prose — so it is reliable regardless of
 *  worker model. `tasks` are the executed tasks (status done|failed); `pendingCount` = never reached. Pure. */
export function renderOrchestrationOutcome(tasks: PlanTask[], pendingCount: number): string {
  const lines = tasks.map((t) =>
    t.status === "done"
      ? ` ✓ ${t.title}${fileSuffix(t.producedFiles ?? [])}`
      : t.status === "partial"
        ? ` ◐ ${t.title}${fileSuffix(t.producedFiles ?? [])} — partial (stopped before verification)`
        : ` ✗ ${t.title} — incomplete (stopped without converging)`,
  );
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const total = tasks.length + pendingCount;
  const reached = pendingCount > 0 ? `; ${pendingCount} not reached.` : ".";
  const tally = `${doneCount} of ${total} task(s) completed${reached}`;
  return `I built this via orchestrated workers:\n${lines.join("\n")}\n${tally}`;
}

/** Headroom (in tasks) every plan gets on top of its multiplicative budget, so tiny plans aren't
 *  over-constrained. Code constant — deliberately not exposed in config. */
export const SCOPE_FLOOR = 3;

/** Objective-relative scope budget for a run whose approved plan had `initialCount` tasks. The
 *  multiplicative cap dominates for larger plans; the additive floor protects tiny ones. Pure. */
export function computeScopeBudget(initialCount: number, maxScopeGrowth: number): number {
  return Math.max(Math.ceil(initialCount * maxScopeGrowth), initialCount + SCOPE_FLOOR);
}

/** Bound replan-proposed work to the objective-relative budget. Each prior failure raises the
 *  ceiling by 1 (`effectiveBudget`), so a correction-heavy run never truncates its own remaining
 *  original work. Keeps the first in-budget tasks (count-based; no title matching) and returns the
 *  dropped tail for a user-facing notice. Pure. */
export function clampScope(args: {
  doneCount: number;
  failedCount: number;
  proposed: PlanTask[];
  scopeBudget: number;
}): { kept: PlanTask[]; dropped: PlanTask[] } {
  const effectiveBudget = args.scopeBudget + args.failedCount;
  const room = Math.max(0, effectiveBudget - args.doneCount);
  if (args.proposed.length <= room) return { kept: args.proposed, dropped: [] };
  return { kept: args.proposed.slice(0, room), dropped: args.proposed.slice(room) };
}

function taskKey(title: string): string {
  return title
    .replace(/^retry:\s*/i, "")
    .trim()
    .toLowerCase();
}

/** Apply a replan as a PATCH over the still-pending approved plan. Original tasks are never
 * silently dropped: exact-title matches may be edited/reordered, genuinely new recovery tasks
 * consume bounded recovery slots, and omitted originals are appended unchanged. A failed editing
 * task also remains as a final integration retry: recovery leaves may prepare it, never replace it. */
export function reconcileReplan(args: {
  original: PlanTask[];
  proposed: PlanTask[];
  recoveryRoom: number;
  /** The task that just failed. New recovery work must not narrow its definition of done. */
  failedTask?: PlanTask;
  /** True once any implementation task in the run has landed files. */
  hasLandedArtifacts?: boolean;
}): { tasks: PlanTask[]; added: number; dropped: PlanTask[] } {
  const originals = new Map(args.original.map((t) => [taskKey(t.title), t]));
  const usedOriginals = new Set<string>();
  const usedProposals = new Set<string>();
  const tasks: PlanTask[] = [];
  const orderedOriginals: PlanTask[] = [];
  const dropped: PlanTask[] = [];
  let added = 0;
  const effectiveRecoveryRoom = args.failedTask?.producedFiles?.length
    ? Math.min(args.recoveryRoom, 2)
    : args.recoveryRoom;
  const failedKey = args.failedTask ? taskKey(args.failedTask.title) : null;
  let proposedRetry: PlanTask | undefined;

  for (const proposed of args.proposed) {
    const key = taskKey(proposed.title);
    if (usedProposals.has(key)) continue;
    usedProposals.add(key);
    const original = originals.get(key);
    if (original) {
      usedOriginals.add(key);
      orderedOriginals.push({
        ...original,
        title: proposed.title,
        description: proposed.description,
        agentType: proposed.agentType,
        acceptanceCriteria: proposed.acceptanceCriteria ?? original.acceptanceCriteria,
        status: "pending",
      });
      continue;
    }
    // A model-authored retry of the failed parent is the integration spine below, not additional
    // recovery scope. Hold it until after preparatory recovery tasks.
    if (failedKey && key === failedKey && args.failedTask?.agentType === "general") {
      proposedRetry = proposed;
      continue;
    }
    // Once an editing task has concrete artifacts, a fresh inventory/exploration recovery is
    // rediscovery, not progress. Continue or split the remaining implementation directly.
    if (
      (args.failedTask?.producedFiles?.length || args.hasLandedArtifacts) &&
      proposed.agentType === "explore"
    ) {
      dropped.push(proposed);
      continue;
    }
    // The runtime already owns final semantic, lint, typecheck, and build gates. A replan must
    // repair the failed implementation, not grow a chain of workers whose only job is rerunning
    // the same checks or re-proving an environmental baseline.
    if (isVerificationOnlyTitle(proposed.title)) {
      dropped.push(proposed);
      continue;
    }
    if (added < effectiveRecoveryRoom) {
      tasks.push({ ...proposed, status: "pending" });
      added++;
    } else {
      dropped.push(proposed);
    }
  }

  const inherited = args.failedTask?.acceptanceCriteria ?? [];
  if (args.failedTask?.agentType === "general") {
    tasks.push({
      ...args.failedTask,
      ...proposedRetry,
      id: `retry-${args.failedTask.id}`,
      title: proposedRetry?.title ?? `Retry: ${args.failedTask.title}`,
      description: proposedRetry?.description ?? args.failedTask.description,
      agentType: "general",
      status: "pending",
      acceptanceCriteria: [
        ...new Set([...(proposedRetry?.acceptanceCriteria ?? []), ...inherited]),
      ],
      producedFiles: undefined,
    });
  }

  tasks.push(...orderedOriginals);

  for (const original of args.original) {
    if (!usedOriginals.has(taskKey(original.title))) tasks.push(original);
  }
  return { tasks, added, dropped };
}

/** JSON schema for the structuring/replan output — describes exactly what STRUCTURE_SYSTEM
 *  already asks for (brief + tasks[{title, description, agent_type}]). All-required +
 *  additionalProperties:false for strict-mode compatibility; parseStructuredPlan remains the
 *  validator and tolerates anything (fence path stays for memoized/off backends). */
export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    brief: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          agent_type: { type: "string", enum: ["general", "explore"] },
          acceptance: { type: "array", items: { type: "string" } },
        },
        required: ["title", "description", "agent_type", "acceptance"],
        additionalProperties: false,
      },
    },
  },
  required: ["brief", "tasks"],
  additionalProperties: false,
} as const;

const PLAN_RESPONSE_FORMAT = { name: "plan", kind: "json", schema: PLAN_SCHEMA } as const;

/**
 * Parse a structured plan from model text. Tolerant of surrounding prose and fenced blocks.
 * Clamps tasks to `maxTasks`, defaults missing `agent_type` to general, assigns t1.. ids.
 * Returns null on any failure (no block, bad JSON, schema mismatch, or zero tasks).
 */
export function parseStructuredPlan(text: string, maxTasks: number): ParsedPlan | null {
  const block = extractJsonBlock(text);
  if (!block) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return null;
  }
  const parsed = RawPlanSchema.safeParse(raw);
  if (!parsed.success) return null;
  const clamped = parsed.data.tasks.slice(0, maxTasks);
  if (clamped.length === 0) return null;
  const tasks: PlanTask[] = clamped.map((t, i) => ({
    id: `t${i + 1}`,
    title: t.title,
    description: t.description,
    agentType: t.agent_type ?? "general",
    status: "pending",
    acceptanceCriteria: t.acceptance,
  }));
  return { brief: parsed.data.brief ?? "", tasks };
}

const UI_COMPONENT_TERMS = [
  "app",
  "header",
  "transcript",
  "message-log",
  "history",
  "tool-line",
  "reasoning-panel",
  "footer",
  "input",
  "composer",
  "status-bar",
  "busy-indicator",
  "command-panel",
  "picker",
  "modal",
  "prompt",
  "overlay",
] as const;

const UI_OWNERSHIP_VERBS =
  /\b(?:add|build|create|extract|implement|refactor|replace|rewrite|split|wire)\b/;

function isUiComponentPath(path: string): boolean {
  if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)/.test(path)) return false;
  if (/\.(?:test|spec)\.(?:tsx|jsx|vue|svelte)$/.test(path)) return false;
  if (/(?:^|\/)src\/(?:main|index)\.(?:tsx|jsx|vue|svelte)$/.test(path)) return false;
  return true;
}

/** Reject UI leaves whose owned surface area predictably exceeds one worker turn.
 *
 * Only the title is used for named surfaces. Descriptions routinely enumerate every picker and
 * prompt as compatibility constraints; treating those mentions as owned implementation work made
 * a reasonable decomposition impossible in the codex13 smoke run. Explicit source paths remain
 * strong evidence when the task also uses an implementation verb. Test files and application
 * entrypoints are supporting seams rather than independently owned UI components. */
export function oversizedUiTaskReason(task: PlanTask): string | null {
  const title = task.title.toLowerCase();
  const text = `${title}\n${task.description.toLowerCase()}`;
  const paths = UI_OWNERSHIP_VERBS.test(text)
    ? new Set(
        (text.match(/(?:src|apps)\/[a-z0-9_./-]+\.(?:tsx|jsx|vue|svelte)/g) ?? []).filter(
          isUiComponentPath,
        ),
      )
    : new Set<string>();
  const words = new Set(title.split(/[^a-z0-9-]+/u).filter(Boolean));
  const named = UI_COMPONENT_TERMS.filter((term) => words.has(term));
  const complexSurface = named.some((term) =>
    ["composer", "history", "input", "message-log", "transcript"].includes(term),
  );
  const bulkCollection =
    UI_OWNERSHIP_VERBS.test(title) &&
    /\ball\b.{0,40}\b(?:pickers?|modals?|prompts?|components?)\b/.test(title);
  if (
    paths.size <= 3 &&
    named.length <= 3 &&
    !bulkCollection &&
    !(complexSurface && named.length > 1)
  ) {
    return null;
  }
  const surfaces = paths.size > named.length ? [...paths] : named;
  const evidence = surfaces.length > 0 ? ` (${surfaces.join(", ")})` : "";
  return `task "${task.title}" owns ${Math.max(paths.size, named.length)} UI surfaces${evidence}; split it into coherent interaction flows of at most three components each`;
}

/** Reject plans that push runtime-owned integration gates or an unbounded inventory into a leaf. */
export function runtimeOwnedGateEvidence(text: string): string | null {
  const patterns = [
    /\bbun test\b(?!\s+(?:\.?\/?tests?\/|-[tF]\b|--filter\b))[^.;\n]*/i,
    /\b(?:full|entire|repository-wide)\s+(?:test\s+)?suite\b[^.;\n]*/i,
    /\bbun run (?:build|lint|typecheck)\b[^.;\n]*/i,
    /\b(?:clean|starting-revision) baseline\b[^.;\n]*/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern)?.[0]?.trim();
    if (match) return match;
  }
  return null;
}

function stripRuntimeOwnedGate(text: string): string {
  const pieces = text.split(/(?<=[.!?;])\s+|\n+/u);
  const kept: string[] = [];
  for (const piece of pieces) {
    const evidence = runtimeOwnedGateEvidence(piece);
    if (!evidence) {
      if (piece.trim()) kept.push(piece.trim());
      continue;
    }
    const prefix = piece
      .slice(0, piece.toLowerCase().indexOf(evidence.toLowerCase()))
      .replace(/(?:,?\s*(?:and|then|also)?\s*(?:run|ensure|verify|confirm)?\s*(?:the)?)\s*$/i, "")
      .trim();
    if (prefix.length >= 12) kept.push(prefix);
  }
  return kept.join(" ").trim();
}

export interface NormalizedStructuredPlan {
  plan: ParsedPlan | null;
  changes: string[];
}

/** Remove integration gates already owned by the runtime without asking a model to repeat itself.
 * Product implementation and focused leaf checks remain untouched. */
export function normalizeStructuredPlan(plan: ParsedPlan): NormalizedStructuredPlan {
  const changes: string[] = [];
  const tasks: PlanTask[] = [];
  for (const task of plan.tasks) {
    const description = stripRuntimeOwnedGate(task.description);
    const acceptanceCriteria = (task.acceptanceCriteria ?? [])
      .map(stripRuntimeOwnedGate)
      .filter(Boolean);
    const hadGate = runtimeOwnedGateEvidence(
      `${task.description}\n${(task.acceptanceCriteria ?? []).join("\n")}`,
    );
    const verificationOnly =
      isVerificationOnlyTitle(task.title) ||
      /^(?:run|execute)\s+(?:the\s+)?(?:full|entire|repository-wide)\b/i.test(task.title);
    if (hadGate && verificationOnly && !description && acceptanceCriteria.length === 0) {
      changes.push(`dropped runtime-owned verification task "${task.title}"`);
      continue;
    }
    if (hadGate) {
      changes.push(`removed runtime-owned gate "${hadGate}" from "${task.title}"`);
    }
    const namedFocusedTest = description.match(
      /(?:\.?\/?tests?\/[A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?)/i,
    )?.[0];
    tasks.push({
      ...task,
      description: description || task.description,
      acceptanceCriteria:
        acceptanceCriteria.length > 0
          ? acceptanceCriteria
          : namedFocusedTest
            ? [`bun test ${namedFocusedTest}`]
            : [],
    });
  }
  return {
    plan: tasks.length > 0 ? { ...plan, tasks: reindex(tasks, 0) } : null,
    changes,
  };
}

export function planTaskQualityReason(task: PlanTask): string | null {
  const text = `${task.description}\n${(task.acceptanceCriteria ?? []).join("\n")}`.toLowerCase();
  const gateEvidence = runtimeOwnedGateEvidence(text);
  if (gateEvidence) {
    return `task "${task.title}" assigns a repository-wide quality, build, or baseline gate to a leaf worker (offending text: "${gateEvidence}"); replace it with focused acceptance for this task`;
  }
  if (task.agentType === "explore") {
    if (/\b(?:scaffold|implement|create|write|edit|add|wire|update)\b/i.test(text)) {
      return `explore task "${task.title}" mixes read-only discovery with implementation; keep it to one blocking finding or make the implementation a focused general task`;
    }
    const paths = new Set(text.match(/(?:src|apps|tests)\/[a-z0-9_./-]+/g) ?? []);
    const numberedAsks = text.match(/(?:^|\s)\([0-9]+\)/g)?.length ?? 0;
    if (task.description.length > 1200 || paths.size > 6 || numberedAsks > 3) {
      return `explore task "${task.title}" is an unbounded repository inventory; fold targeted reads into implementation tasks or narrow it to one blocking question`;
    }
  }
  return oversizedUiTaskReason(task);
}

export interface OrchestratorDeps {
  config: OrchestrationConfig;
  /** Orchestrator model id, resolved LIVE at each call (mirrors the active session model unless
   *  config pins it) — a thunk so a model picked after wiring / a later /model switch is honoured. */
  orchestratorModel: () => string;
  /** Tool-less model call: returns accumulated text ("" on error/abort). Optional 5th param
   *  requests constrained decoding for structure/replan (WS4); the closing call omits it. */
  callModel: (
    model: string,
    system: string,
    user: string,
    signal: AbortSignal,
    responseFormat?: { name: string; schema: object; kind: "tool-call" | "json" },
  ) => Promise<string>;
  /** Worker spawner already bound to the worker model (via a live router). */
  spawnWorker: SpawnWorker;
  /** Optional worker spawner bound to the stronger orchestrator model/provider. Used for one
   *  stopped-worker recovery attempt and the final semantic integration pass. */
  spawnRecoveryWorker?: SpawnWorker;
  /** Live user standing instructions ("" when none), folded into the structuring/replan system
   *  prompts so the decomposer authors steps that respect user preferences. */
  userInstructions?: () => string;
  /** Decomposition skill guidance for an input (the original request). "" when no skill applies
   *  or auto-invoke is off. Absent → the structuring prompt is unchanged. */
  decomposeGuidance?: (input: string) => string;
  /** Execution-framed skill reminders to seed into every worker turn, computed from the frozen
   *  objective. [] when no skill applies or auto-invoke is off. Absent → no seed. */
  workerSkillSeed?: (input: string) => string[];
  /** Live "planner X · worker Y" roster for the kickoff notice. "" / absent → omit it. */
  rosterLine?: () => string;
  /** Live personality voice overlay ("" for neutral), applied to the user-facing CLOSING summary
   *  only. Structuring/replan stay voiceless so their JSON parses cleanly (cf. the #118 fence bug).
   *  Absent or "" → the closing system prompt is byte-identical to omitting it. */
  voiceOverlay?: () => string;
  /** Deterministic post-build wiring check ("config doctor"). Absent → skipped. Returns the
   *  current violations; the orchestrator attempts ONE corrective worker pass then re-checks. */
  inspectProject?: (signal: AbortSignal) => Promise<Violation[]>;
  /** Deterministic post-loop build/coherence gate. Absent → disabled. Runs the detected build; on
   *  failure dispatches `fix` corrective worker passes (bounded by config) and re-builds. Resolves
   *  the outcome for a notice, or `null` when no build command is detected at call time (skip). */
  verifyBuild?: (
    fix: (errorTail: string, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ) => Promise<BuildGateResult | null>;
  /** Deterministic final lint/typecheck checks, run outside the verifier model so a retry cannot
   *  omit or reinterpret a failing project gate. Absent → skipped. */
  verifyQuality?: (signal: AbortSignal) => Promise<VerificationResult[]>;
  /** Absolute project/working directory, named in the structuring prompt so the decomposer
   *  scaffolds INTO the existing project rather than authoring a "create a new root folder" task.
   *  Static (fixed at startup); absent → the anchor is omitted (tests / degenerate callers). */
  projectDir?: string;
  /** Lists a given directory's top-level names (used for the per-worker + replan on-disk
   *  snapshot, targeting the resolved build dir). Absent → no snapshot. */
  listDir?: (path: string) => Promise<string[]>;
  log: { append: (e: EventInput) => void };
  sessionId: string;
  /** Append the orchestration outcome (facts + prose) to the MAIN conversation history so the model
   *  knows the build happened. Wired to runtime.recordOrchestrationSummary(sessionId, …). */
  recordSummary: (text: string) => void;
}

export interface StructureFailure {
  reason: string;
  attempts: number;
  repeated: boolean;
}

export interface RunArgs {
  request: string;
  prosePlan: string;
  /** Where the project should be scaffolded/built. Absent → defaults to `{ kind: "cwd" }`. */
  location?: BootstrapLocation;
  signal: AbortSignal;
}

export type RunResult = { kind: "ran"; complete: boolean } | { kind: "fallback" };

/** A worker "failed to produce changes" when it attempted structured file writes and none
 *  landed. Deliberately keyed on the structured write tools only (bash is excluded), so a task
 *  that merely runs a failing check command is not misread as failed. */
export function workerFailedToProduceChanges(r: {
  failedWrites: number;
  successfulEdits: number;
}): boolean {
  return r.failedWrites > 0 && r.successfulEdits === 0;
}

/** Merge sequential attempts by command identity; the later recovery result is authoritative. */
export function mergeVerificationResults(
  ...groups: (VerificationResult[] | undefined)[]
): VerificationResult[] {
  const latest = new Map<string, VerificationResult>();
  for (const group of groups) {
    for (const result of group ?? []) latest.set(result.key, result);
  }
  return [...latest.values()];
}

/** Leaf workers often run the repository-wide suite as a courtesy. Its failures are integration
 * evidence, not proof that this isolated task is wrong (nested sandboxes and established baseline
 * failures otherwise poison every task/retry). Focused acceptance commands still gate the leaf;
 * the final semantic verifier adjudicates the broad suite against a clean baseline. */
function verificationMatchesAcceptance(task: PlanTask, verification: VerificationResult): boolean {
  const criteria = task.acceptanceCriteria ?? [];
  if (criteria.length === 0) return true; // tolerate older/model-authored plans without the field
  const acceptance = criteria.join("\n").toLowerCase();
  const key = verification.key.toLowerCase();
  if (/\blint\b/.test(key)) return /\blint\b/.test(acceptance);
  if (/typecheck|\btsc\b/.test(key)) return /typecheck|\btsc\b/.test(acceptance);
  if (/\bbuild\b|xcodebuild/.test(key)) return /\bbuild\b|xcodebuild/.test(acceptance);
  const testTarget = key
    .replace(
      /^(?:bash:)?(?:bun test|bun run test|run_tests:|pytest|uv run pytest|cargo test|go test|swift test)\s*/i,
      "",
    )
    .split(/\s/)[0]
    ?.replace(/^['"]|['"]$/g, "");
  if (!testTarget || testTarget === "full") return false;
  const basename = testTarget.split("/").pop() ?? testTarget;
  return acceptance.includes(testTarget) || acceptance.includes(basename);
}

function failedLeafVerificationResults(
  task: PlanTask,
  result: { verificationResults?: VerificationResult[]; editedPaths?: string[] },
) {
  const all = result.verificationResults ?? [];
  const baselineByKey = new Map(
    all
      .filter((verification) => verification.baseline)
      .map((verification) => [verification.key.replace(/:baseline$/, ""), verification]),
  );
  const taskText = `${task.description}\n${(task.acceptanceCriteria ?? []).join("\n")}`;
  const ownedPaths = new Set([
    ...(result.editedPaths ?? []),
    ...(taskText.match(/(?:src|tests|apps)\/[A-Za-z0-9_./-]+/g) ?? []).map((path) =>
      path.replace(/[),.;:`]+$/, ""),
    ),
  ]);
  return all.filter((verification) => {
    if (
      verification.ok ||
      verification.baseline ||
      verification.scope === "full" ||
      !verificationMatchesAcceptance(task, verification)
    ) {
      return false;
    }
    const baseline = baselineByKey.get(verification.key);
    if (
      baseline &&
      (verification.failureIds?.length ?? 0) > 0 &&
      JSON.stringify(verification.failureIds) === JSON.stringify(baseline.failureIds)
    ) {
      return false;
    }
    // Typecheck/lint/build failures that cite only another task's files are integration evidence;
    // retrying this leaf cannot repair them. Targeted test failures remain owned by acceptance.
    if (/typecheck|\btsc\b|\blint\b|\bbuild\b|xcodebuild/i.test(verification.key)) {
      const cited = verification.detail.match(/(?:src|tests|apps)\/[A-Za-z0-9_./-]+/g) ?? [];
      if (cited.length > 0 && !cited.some((path) => ownedPaths.has(path.replace(/:\d.*$/, "")))) {
        return false;
      }
    }
    return true;
  });
}

function semanticVerifierDescription(args: {
  objective: string;
  approvedPlan: string;
  outcomes: PlanTask[];
  pending: PlanTask[];
}): string {
  return `Act as an acceptance verifier with read-only inspection plus permission to run verification commands. Decide whether the repository CURRENTLY implements the original request and approved plan. You must not edit files, install dependencies, run formatters with write flags, or change git state. Inspect the actual changed entry points and cross-file wiring; do not trust task labels, worker summaries, compilation, file existence, or passing leaf-unit tests by themselves. Explicitly detect stubs, pass-through exports, disconnected components, disabled code paths, placeholder implementations, weakened tests, and compile-only shortcuts.

Account for EVERY acceptance criterion recorded below; do not silently omit a failed or inconvenient requirement. The runtime runs configured lint, typecheck, and build commands deterministically outside your model turn, so DO NOT rerun those commands. Use tools only for bounded repository inspection and focused runtime/render/interaction evidence that cannot be established from the changed code and recorded outcomes. If a repository-wide suite has failures and no structured baseline evidence is already recorded below, report regression status unverified rather than spending this turn creating a baseline. Never use git stash, checkout, reset, or another operation that mutates the user's working tree.

For CLI/runtime behavior, --help or --version is not smoke evidence when it exits before the changed runtime path. Prove that the selected entry point/import/render path is actually reached. For visible UI work, importability, file existence, and color-regex tests are insufficient by themselves: require rendered/snapshot evidence when available, inspect layout composition, and verify that advertised controls/keybindings have real handlers. Do not invent subjective aesthetic requirements, but do verify the requested visible behavior.

Begin with git's changed-file list. Every unexpected config, manifest, lockfile, loader, or test-harness change must map to a requirement and be technically necessary; otherwise fail it as unrequested residue. Keep the investigation bounded to changed entry points, direct dependencies, and material verification commands. Build an acceptance matrix as you go. As soon as every row has decisive evidence, return the JSON immediately; do not invent optional checks, improve the evidence, or search for an additional smoke harness. Do not produce conversational prose.

Return ONLY one JSON object with this exact shape:
{"verdict":"pass"|"fail","summary":"short current-state conclusion","checks":[{"requirement":"checkable requirement","status":"pass"|"fail","evidence":"specific file/symbol/test evidence","repair":"small concrete repair for failures; omit for passes"}]}

The verdict must be "fail" if any material requirement is missing, unreachable, stubbed, or unverified.

ORIGINAL REQUEST:
${args.objective}

APPROVED PLAN:
${args.approvedPlan}

RECORDED TASK OUTCOMES (leads only; verify independently):
${
  args.outcomes
    .map((task) => {
      const acceptance = task.acceptanceCriteria?.length
        ? ` Acceptance: ${task.acceptanceCriteria.join("; ")}`
        : "";
      return `- [${task.status}] ${task.title}${fileSuffix(task.producedFiles ?? [])}.${acceptance}`;
    })
    .join("\n") || "(none)"
}

STILL PENDING/NOT REACHED:
${args.pending.map((task) => `- ${task.title}: ${task.description}`).join("\n") || "(none)"}`;
}

function semanticRepairDescription(args: {
  objective: string;
  approvedPlan: string;
  report: SemanticReport;
}): string {
  return `Repair ONLY the failed acceptance checks below, then run focused verification for the changed seams. Inspect the existing partial implementation before editing and preserve working behavior. Do not use stubs, pass-through exports to an old implementation, commented-out features, disabled code paths, weakened/removed tests, hardcoded success, or any other compile-only bypass. Once the listed failures are repaired and their focused checks pass, stop and report; do not spend budget building optional harnesses or re-investigating checks that the read-only verifier owns.

ORIGINAL REQUEST:
${args.objective}

APPROVED PLAN:
${args.approvedPlan}

FAILED ACCEPTANCE CHECKS:
${failedSemanticChecks(args.report)
  .map(
    (check) =>
      `- ${check.requirement}\n  Evidence: ${check.evidence}\n  Required repair: ${check.repair ?? "Implement and wire the missing behavior."}`,
  )
  .join("\n")}`;
}

function buildFixDescription(args: {
  errorTail: string;
  objective: string;
  approvedPlan: string;
  semanticReport?: SemanticReport;
}): string {
  const acceptance = args.semanticReport
    ? renderSemanticReport(args.semanticReport)
    : "Semantic verification was unavailable; preserve every requested behavior conservatively.";
  return `The project does not build. Fix the errors below with the smallest change that remains consistent with the ORIGINAL request and approved plan. Do not add unrelated features.

The build is a mechanical gate, not permission to bypass semantic requirements. Do NOT replace requested behavior with a stub, pass-through/re-export of an old implementation, commented-out or disabled code path, hardcoded success, weakened/removed test, or placeholder merely to make compilation pass. Preserve and complete the intended wiring. If a compliant build fix is not possible in this bounded pass, leave the semantic gap visible and report it honestly.

ORIGINAL REQUEST:
${args.objective}

APPROVED PLAN:
${args.approvedPlan}

LATEST SEMANTIC ACCEPTANCE STATE:
${acceptance}

BUILD OUTPUT:
${args.errorTail}`;
}

export class Orchestrator {
  private lastStructureFailure: StructureFailure | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  private notice(text: string, level: "info" | "warn" = "info"): void {
    this.deps.log.append({
      sessionId: this.deps.sessionId,
      type: "notice",
      payload: { text, level },
    });
  }

  /** Emit an authoritative stop when an explicit orchestration request cannot be structured. */
  noticeStructureFailure(): void {
    const detail = this.lastStructureFailure?.reason;
    this.notice(
      `Orchestration stopped: could not produce a safe task decomposition.${detail ? ` Last issue: ${detail}.` : ""} No implementation was started; repair the decomposition or choose another execution path.`,
      "warn",
    );
  }

  getLastStructureFailure(): StructureFailure | null {
    return this.lastStructureFailure;
  }

  /** Structuring call (up to two corrective reprompts). Returns a parsed plan or null on failure. */
  async structure({
    request,
    prosePlan,
    location,
    signal,
  }: RunArgs): Promise<OrchestrationPlan | null> {
    const { config, orchestratorModel, callModel } = this.deps;
    const loc: BootstrapLocation = location ?? { kind: "cwd" };
    const anchor = renderLocationAnchor(loc, this.deps.projectDir ?? "");
    let parsed: ParsedPlan | null = null;
    let rejection = "";
    let attempts = 0;
    let lastReason = "the model did not return a valid non-empty task list";
    let repeated = false;
    const rejectedFingerprints = new Set<string>();
    this.lastStructureFailure = null;
    for (let attempt = 0; attempt < 3 && !parsed && !signal.aborted; attempt++) {
      attempts++;
      const text = await callModel(
        orchestratorModel(),
        withSkillGuidance(
          withUserInstructions(STRUCTURE_SYSTEM, this.deps.userInstructions?.() ?? ""),
          this.deps.decomposeGuidance?.(request) ?? "",
        ),
        `${structureUser(request, prosePlan, anchor)}${rejection}`,
        signal,
        PLAN_RESPONSE_FORMAT,
      );
      parsed = parseStructuredPlan(text, config.maxTasks);
      if (!parsed) {
        lastReason = "the model did not return a valid non-empty task list";
        const fingerprint = `invalid:${text.trim()}`;
        if (rejectedFingerprints.has(fingerprint)) {
          repeated = true;
          this.notice(
            "↻ Structuring stopped early because the model repeated the same invalid task-list response.",
            "warn",
          );
          break;
        }
        rejectedFingerprints.add(fingerprint);
        rejection = `\n\nPREVIOUS PLAN REJECTED: ${lastReason}. Return the required JSON task list.`;
        continue;
      }
      const normalized = normalizeStructuredPlan(parsed);
      if (normalized.changes.length > 0) {
        this.notice(`↪ Structuring normalized ${normalized.changes.join("; ")}.`, "warn");
      }
      parsed = normalized.plan;
      if (!parsed) {
        lastReason = "every proposed task was a runtime-owned verification gate";
      }
      const qualityProblem = parsed?.tasks.map(planTaskQualityReason).find(Boolean);
      if (parsed && qualityProblem) {
        lastReason = qualityProblem;
        const fingerprint = JSON.stringify({
          tasks: parsed.tasks.map((task) => ({
            title: task.title,
            description: task.description,
            acceptance: task.acceptanceCriteria,
          })),
          problem: qualityProblem,
        });
        parsed = null;
        if (rejectedFingerprints.has(fingerprint)) {
          repeated = true;
          this.notice(
            `↻ Structuring stopped early because the model repeated the same rejected decomposition: ${qualityProblem}.`,
            "warn",
          );
          break;
        }
        rejectedFingerprints.add(fingerprint);
        rejection = `\n\nPREVIOUS PLAN REJECTED: ${qualityProblem}. Return a corrected plan; do not replace implementation with a verification-only task.`;
        this.notice(
          `↻ Structuring rejected ${qualityProblem}; requesting a safer decomposition.`,
          "warn",
        );
      } else if (!parsed) {
        const fingerprint = `empty:${lastReason}`;
        if (rejectedFingerprints.has(fingerprint)) {
          repeated = true;
          this.notice(
            `↻ Structuring stopped early because the model repeated the same rejected decomposition: ${lastReason}.`,
            "warn",
          );
          break;
        }
        rejectedFingerprints.add(fingerprint);
        rejection = `\n\nPREVIOUS PLAN REJECTED: ${lastReason}. Return implementation tasks with focused leaf acceptance; omit runtime-owned final verification.`;
      }
    }
    // Freeze the original request as the immutable scope anchor (the model never sets it), along
    // with the location every replan/worker anchor must agree with.
    if (parsed) return { ...parsed, objective: request, location: loc, approvedPlan: prosePlan };
    if (!signal.aborted) this.lastStructureFailure = { reason: lastReason, attempts, repeated };
    return null;
  }

  /** Run the sequential work→replan→closing loop on an already-structured plan. */
  async execute(plan: OrchestrationPlan, signal: AbortSignal): Promise<RunResult> {
    const { config, orchestratorModel, callModel } = this.deps;
    const objective = plan.objective;
    // Full anchor for planner-facing use (replan). Per-worker anchors are rendered in the loop with
    // a scaffold flag; this one keeps the scaffold clause (byte-identical to the old locationAnchor).
    const planAnchor = renderLocationAnchor(plan.location, this.deps.projectDir ?? "");
    const buildPath = resolveBuildDir(this.deps.projectDir ?? "", plan.location);
    const workerSeed = this.deps.workerSkillSeed?.(objective) ?? [];
    // Capture the approved size BEFORE the loop mutates `pending` (which aliases plan.tasks).
    const initialCount = plan.tasks.length;
    const scopeBudget = computeScopeBudget(initialCount, config.maxScopeGrowth);
    const recoveryBudget = Math.max(0, scopeBudget - initialCount);
    let recoveryAdded = 0;
    let brief = plan.brief;
    let pending = plan.tasks;
    const done: PlanTask[] = [];
    const logicalTaskAttempts = new Map<string, number>();
    const roster = this.deps.rosterLine?.();
    this.notice(`Orchestrating ${pending.length} task(s).${roster ? ` · ${roster}` : ""}`);
    let replans = 0;
    while (pending.length > 0) {
      if (signal.aborted) break;
      const task = pending.shift()!;
      const logicalKey = taskKey(task.title);
      const logicalAttempt = (logicalTaskAttempts.get(logicalKey) ?? 0) + 1;
      logicalTaskAttempts.set(logicalKey, logicalAttempt);
      task.status = "running";
      const total = done.length + pending.length + 1;
      this.notice(`▶ Task ${done.length + 1}/${total}: ${task.title}`);
      let result: string;
      let ok = true;
      let workFailed = false;
      let verificationOnlyFailure = false;
      let failedWriteCount = 0;
      let budgetStop = false;
      let stopReason:
        | "loop_limit"
        | "token_budget"
        | "time_budget"
        | "thrash"
        | "hidden_tools"
        | "no_progress"
        | "premature_completion"
        | "stream_watchdog"
        | "provider_error"
        | "cancelled"
        | undefined;
      let outcome: Awaited<ReturnType<typeof this.runWorker>> | undefined;
      try {
        const entries = this.deps.listDir ? await this.deps.listDir(buildPath) : null;
        const scaffold = done.length === 0 && (entries === null || isFreshBootstrap(entries));
        const workerCtx = {
          anchor: renderLocationAnchor(plan.location, this.deps.projectDir ?? "", { scaffold }),
          onDiskSnapshot: entries ? describeOnDisk(entries) : "",
          doneEntries: taskOutcomeEntries(done),
          upcomingTitles: pending.map((t) => t.title),
        };
        outcome = await this.runWorker(task, brief, signal, workerSeed, workerCtx);
        if (
          outcome.stoppedReason &&
          logicalAttempt === 1 &&
          config.recoveryEscalation &&
          this.deps.spawnRecoveryWorker &&
          !signal.aborted
        ) {
          this.notice(
            `↻ Escalating stopped task ${task.title} to the orchestrator model for one recovery pass.`,
            "warn",
          );
          const first = outcome;
          const recoveryCtx = {
            ...workerCtx,
            doneEntries: [
              ...workerCtx.doneEntries,
              {
                title: task.title,
                status: first.editedPaths.length > 0 ? ("partial" as const) : ("failed" as const),
                files: first.editedPaths,
                acceptance: task.acceptanceCriteria,
                summary: boundTaskHandoff(
                  first.progressSummary ??
                    `${first.assistantText}\nFiles changed: ${first.editedPaths.join(", ") || "none"}`,
                ),
              },
            ],
          };
          const recovered = await this.runWorker(
            task,
            brief,
            signal,
            workerSeed,
            recoveryCtx,
            this.deps.spawnRecoveryWorker,
          );
          outcome = {
            ...recovered,
            assistantText: `${first.assistantText}\n\n[recovery pass]\n${recovered.assistantText}`,
            successfulEdits: first.successfulEdits + recovered.successfulEdits,
            failedWrites: first.failedWrites + recovered.failedWrites,
            editedPaths: [...new Set([...first.editedPaths, ...recovered.editedPaths])],
            verificationResults: mergeVerificationResults(
              first.verificationResults,
              recovered.verificationResults,
            ),
            progressSummary: [first.progressSummary, recovered.progressSummary]
              .filter(Boolean)
              .join("\n\n[recovery continuation]\n"),
            budgetExtensions: (first.budgetExtensions ?? 0) + (recovered.budgetExtensions ?? 0),
          };
        } else if (
          outcome.stoppedReason &&
          logicalAttempt > 1 &&
          config.recoveryEscalation &&
          this.deps.spawnRecoveryWorker &&
          !signal.aborted
        ) {
          this.notice(
            `↪ Skipping another strong-model recovery for ${task.title}; this logical task already received one recovery pass and must now preserve its evidence or yield to unrelated work.`,
            "warn",
          );
        }
        result = outcome.assistantText;
        const unresolvedVerification = failedLeafVerificationResults(task, outcome);
        if (unresolvedVerification.length > 0) {
          workFailed = true;
          ok = false;
          verificationOnlyFailure = !outcome.stoppedReason && outcome.failedWrites === 0;
          result += `\n\n[orchestrator note: ${unresolvedVerification.length} verification command(s) still fail; a worker's claim that they are unrelated cannot satisfy acceptance.\n${unresolvedVerification
            .map((verification) => `- ${verification.command}: ${verification.detail.slice(-1000)}`)
            .join("\n")}]`;
        }
        if (outcome.stoppedReason !== "no_progress" && workerFailedToProduceChanges(outcome)) {
          workFailed = true;
          ok = false;
          failedWriteCount = outcome.failedWrites;
          result += `\n\n[orchestrator note: this task made no successful file changes; ${outcome.failedWrites} structured write(s) were blocked or failed.]`;
        }
        if (outcome.stoppedReason === "no_progress") {
          workFailed = true;
          ok = false;
          budgetStop = true;
          stopReason = "no_progress";
          result +=
            "\n\n[orchestrator note: this task was stopped for not converging — no file changes in the last stretch of work (likely stuck or hunting). Reassign it, split it smaller, or route it to a stronger model.]";
        }
        if (outcome.stoppedReason === "loop_limit") {
          workFailed = true;
          ok = false;
          budgetStop = true;
          stopReason = "loop_limit";
          result +=
            "\n\n[orchestrator note: this task reached its model/tool-round safety checkpoint. This is not evidence that its landed work was unproductive; continue from the durable progress handoff before considering a replan.]";
        }
        if (outcome.stoppedReason === "token_budget") {
          workFailed = true;
          ok = false;
          budgetStop = true;
          stopReason = "token_budget";
          result +=
            "\n\n[orchestrator note: this task reached its billed-token cost ceiling. This is not by itself evidence of non-convergence; continue from the durable progress handoff before considering a replan.]";
        }
        if (outcome.stoppedReason === "time_budget") {
          workFailed = true;
          ok = false;
          budgetStop = true;
          stopReason = "time_budget";
          result +=
            "\n\n[orchestrator note: this task was stopped for exceeding its wall-clock budget without converging. It may be stuck; reassign it, split it smaller, or raise orchestration.worker_turn_ms.]";
        }
        if (outcome.stoppedReason === "thrash") {
          workFailed = true;
          ok = false;
          budgetStop = true;
          stopReason = "thrash";
          result +=
            "\n\n[orchestrator note: this task was stopped because one command failed repeatedly without converging. It is likely stuck on a bad command; reassign it, split it smaller, or route it to a stronger model.]";
        }
        if (outcome.stoppedReason === "hidden_tools") {
          workFailed = true;
          ok = false;
          budgetStop = true;
          stopReason = "hidden_tools";
          result +=
            "\n\n[orchestrator note: this task was stopped for repeatedly calling tools that are not available in this session. Reassign it or route it to a stronger model.]";
        }
        if (outcome.stoppedReason === "premature_completion") {
          workFailed = true;
          ok = false;
          budgetStop = true;
          stopReason = "premature_completion";
          result +=
            "\n\n[orchestrator note: the model repeatedly ended its turn while its own todo list was unfinished. Treat the landed work as partial and continue or reassign it.]";
        }
        if (outcome.stoppedReason === "provider_error") {
          workFailed = true;
          ok = false;
          budgetStop = true;
          stopReason = "provider_error";
          result +=
            "\n\n[orchestrator note: the model provider failed after a retry. Preserve completed edits and treat this task as incomplete.]";
        }
        if (outcome.stoppedReason === "stream_watchdog") {
          workFailed = true;
          ok = false;
          budgetStop = true;
          stopReason = "stream_watchdog";
          result +=
            "\n\n[orchestrator note: the model stream was stopped by a mechanical watchdog (silence, hard call ceiling, consecutive degeneration, or an explicitly enabled rumination detector). The task did not complete.]";
        }
        if (outcome.stoppedReason === "cancelled") {
          workFailed = true;
          ok = false;
          budgetStop = true;
          stopReason = "cancelled";
          result += "\n\n[orchestrator note: the user cancelled this worker; it did not complete.]";
        }
      } catch (e) {
        ok = false;
        result = `worker error: ${e instanceof Error ? e.message : String(e)}`;
      }
      // A stopped worker may still have landed valuable edits. Preserve those artifacts and mark
      // the task partial instead of collapsing "interrupted after edits" into "failed".
      task.producedFiles = outcome?.editedPaths ?? [];
      task.status = ok ? "done" : task.producedFiles.length > 0 ? "partial" : "failed";
      // File-producing tasks hand off through concrete paths. Read-only/no-file tasks must carry
      // their actual findings or every context-isolated successor has to rediscover them.
      const shouldCarryResultSummary =
        Boolean(outcome?.progressSummary) ||
        Boolean(result && (task.agentType === "explore" || task.producedFiles.length === 0));
      const preferredHandoff =
        outcome && !outcome.stoppedReason && result ? result : (outcome?.progressSummary ?? result);
      task.resultSummary = shouldCarryResultSummary
        ? boundTaskHandoff(preferredHandoff)
        : undefined;
      done.push(task);
      this.notice(
        ok
          ? `✓ Task ${done.length} done`
          : budgetStop
            ? stopReason === "thrash"
              ? `✗ Task ${done.length} stopped: the same command failed repeatedly without converging (may have made partial changes)`
              : stopReason === "hidden_tools"
                ? `✗ Task ${done.length} stopped: repeatedly called tools that are not available in this session (may have made partial changes)`
                : stopReason === "premature_completion"
                  ? `✗ Task ${done.length} stopped before completing its own todo list (may have made partial changes)`
                  : stopReason === "cancelled"
                    ? `✗ Task ${done.length} cancelled (may have made partial changes)`
                    : stopReason === "stream_watchdog"
                      ? `✗ Task ${done.length} stopped: model stream watchdog fired (may have made partial changes)`
                      : stopReason === "provider_error"
                        ? `✗ Task ${done.length} stopped: model provider failed after a retry (may have made partial changes)`
                        : stopReason === "no_progress"
                          ? `✗ Task ${done.length} stopped: no file changes in the last stretch of work — not converging (may have made partial changes)`
                          : stopReason === "time_budget"
                            ? `✗ Task ${done.length} stopped: exceeded its wall-clock budget without converging (may have made partial changes)`
                            : stopReason === "loop_limit"
                              ? `✗ Task ${done.length} stopped: reached its model/tool-round safety checkpoint (may have made partial changes)`
                              : `✗ Task ${done.length} stopped: reached its billed-token cost ceiling (may have made partial changes)`
            : workFailed
              ? failedWriteCount > 0
                ? `✗ Task ${done.length} failed: no changes made (${failedWriteCount} write(s) blocked/failed)`
                : `✗ Task ${done.length} failed: verification command(s) still failing`
              : `✗ Task ${done.length} failed`,
        ok ? "info" : "warn",
      );
      if (signal.aborted) break;
      // C1: replan ONLY on failure. A successful task advances to the next already-structured
      // task with no planner call — the up-front plan is usually right for a linear build, and
      // the post-loop integration + build gates remain the safety net for cross-task drift.
      if (!ok) {
        if (verificationOnlyFailure) {
          this.notice(
            `↪ Deferring ${task.title}'s unresolved verification evidence to the deterministic final integration gates; no verification-only recovery tasks will be added.`,
            "warn",
          );
          continue;
        }
        if (logicalAttempt >= config.maxTaskAttempts) {
          this.notice(
            `✗ Retry ceiling: ${task.title} exhausted ${logicalAttempt}/${config.maxTaskAttempts} logical attempt(s); preserving the failure and continuing with other approved work.`,
            "warn",
          );
          continue;
        }
        // A token-cost stop with landed artifacts gets one deterministic continuation of the
        // same frozen task before any planner is allowed to redefine or explode its remainder.
        if (
          (stopReason === "token_budget" || stopReason === "loop_limit") &&
          task.producedFiles.length > 0 &&
          logicalAttempt < config.maxTaskAttempts
        ) {
          pending = [
            {
              ...task,
              id: `retry-${task.id}`,
              title: `Retry: ${task.title.replace(/^Retry:\s*/i, "")}`,
              status: "pending",
              producedFiles: undefined,
            },
            ...pending,
          ];
          this.notice(
            `↻ Continuing ${task.title} from its durable progress handoff before replanning.`,
            "warn",
          );
          continue;
        }
        if (replans >= config.maxReplans) {
          this.notice(
            `✗ Replan ceiling reached (${config.maxReplans}); preserving ${task.title} as failed and continuing without additional recovery planning.`,
            "warn",
          );
          continue;
        }
        replans++;
        const replanEntries = this.deps.listDir ? await this.deps.listDir(buildPath) : [];
        const stateSnapshot = snapshotProjectMarkers(replanEntries);
        const text = await callModel(
          orchestratorModel(),
          withUserInstructions(REPLAN_SYSTEM, this.deps.userInstructions?.() ?? ""),
          replanUser(objective, brief, task, result, pending, planAnchor, stateSnapshot, done),
          signal,
          PLAN_RESPONSE_FORMAT,
        );
        const replanned = parseStructuredPlan(text, config.maxTasks);
        if (replanned) {
          brief = replanned.brief || brief; // safe: brief is notes; objective is the frozen anchor
          const reconciled = reconcileReplan({
            original: pending,
            proposed: replanned.tasks,
            recoveryRoom: Math.max(0, recoveryBudget - recoveryAdded),
            failedTask: task,
            hasLandedArtifacts: done.some((entry) => (entry.producedFiles?.length ?? 0) > 0),
          });
          recoveryAdded += reconciled.added;
          if (reconciled.dropped.length > 0) {
            this.notice(
              `⚠ Scope guard: deferred ${reconciled.dropped.length} additional recovery task(s) beyond the requested scope (~${initialCount}); original pending tasks were preserved: ${reconciled.dropped.map((t) => t.title).join(", ")}.`,
              "warn",
            );
          }
          pending = reindex(reconciled.tasks, done.length);
          this.notice(`Plan updated: ${pending.length} task(s) remaining.`);
        }
      }
    }
    // Semantic acceptance is deliberately split into a read-only verifier and a bounded repair.
    // This prevents a large "inspect + understand + refactor + implement + test" integration turn
    // from burning its whole budget before editing, and gives the final summary structured evidence.
    const semanticEnabled =
      !signal.aborted &&
      initialCount > 1 &&
      config.finalIntegration &&
      Boolean(this.deps.spawnRecoveryWorker);
    let semanticReport: SemanticReport | undefined;
    let semanticNeedsRecheck = false;
    let semanticRepairFiles: string[] = [];
    let semanticRepairUsed = false;
    const approvedPlan = plan.approvedPlan ?? brief;
    const verifySemantics = async (): Promise<SemanticReport | undefined> => {
      for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
        const entries = this.deps.listDir ? await this.deps.listDir(buildPath) : null;
        const task: PlanTask = {
          id: "integration-verify",
          title: "Verify the approved plan against the repository",
          description: semanticVerifierDescription({
            objective,
            approvedPlan,
            outcomes: done,
            pending,
          }),
          agentType: "review",
          status: "running",
        };
        try {
          const outcome = await this.runWorker(
            task,
            brief,
            signal,
            workerSeed,
            {
              anchor: renderLocationAnchor(plan.location, this.deps.projectDir ?? "", {
                scaffold: false,
              }),
              onDiskSnapshot: entries ? describeOnDisk(entries) : "",
              // The verifier description already contains the concise outcome ledger. Repeating
              // every worker handoff here inflated glm-orch1 verifier prompts past 20K chars and
              // encouraged it to relitigate stale investigation instead of inspecting the diff.
              doneEntries: [],
              upcomingTitles: [],
            },
            this.deps.spawnRecoveryWorker!,
            { protocolOutput: true, convergeEarly: true },
          );
          // A stopped verifier may still have returned valid JSON before the runtime enforced its
          // final-response boundary. Parse first; otherwise allow the existing second attempt.
          const report = parseSemanticReport(outcome.assistantText);
          if (report) {
            // Broad-suite failures are adjudicated by the verifier's explicit baseline check.
            // Focused failures remain deterministic and cannot be waved away in prose/JSON.
            const modelCommands = failedLeafVerificationResults(task, outcome);
            const deterministic = (await this.deps.verifyQuality?.(signal)) ?? [];
            const failedCommands = mergeVerificationResults(modelCommands, deterministic).filter(
              (verification) => !verification.ok,
            );
            if (failedCommands.length === 0) return report;
            return {
              verdict: "fail",
              summary: `${report.summary} ${failedCommands.length} verifier command(s) failed.`,
              checks: [
                ...report.checks,
                ...failedCommands.map((verification) => ({
                  requirement: `Verification command passes: ${verification.command}`,
                  status: "fail" as const,
                  evidence: verification.detail.slice(-2000),
                  repair:
                    "Fix the failure and rerun the same command successfully; do not dismiss it in prose.",
                })),
              ],
            };
          }
          if (outcome.stoppedReason) continue;
        } catch {
          // A thrown verifier attempt gets the same single retry as malformed final JSON.
        }
        if (attempt === 0 && !signal.aborted) {
          this.notice("↻ Semantic verifier returned invalid evidence; retrying once.", "warn");
        }
      }
      return undefined;
    };

    const repairSemantics = async (report: SemanticReport): Promise<void> => {
      if (semanticRepairUsed || signal.aborted) return;
      semanticRepairUsed = true;
      this.notice(
        `◇ Semantic acceptance found ${failedSemanticChecks(report).length} failed requirement(s); dispatching the bounded repair.`,
        "warn",
      );
      const repairTask: PlanTask = {
        id: "integration-repair",
        title: "Repair failed semantic acceptance checks",
        description: semanticRepairDescription({ objective, approvedPlan, report }),
        agentType: "general",
        status: "running",
      };
      try {
        const entries = this.deps.listDir ? await this.deps.listDir(buildPath) : null;
        const repaired = await this.runWorker(
          repairTask,
          brief,
          signal,
          workerSeed,
          {
            anchor: renderLocationAnchor(plan.location, this.deps.projectDir ?? "", {
              scaffold: false,
            }),
            onDiskSnapshot: entries ? describeOnDisk(entries) : "",
            // Failed checks plus the approved plan are the repair contract. Prior worker prose is
            // stale context and can pull the repair back into already-failed implementation paths.
            doneEntries: [],
            upcomingTitles: [],
          },
          this.deps.spawnRecoveryWorker!,
          { convergeEarly: true },
        );
        semanticRepairFiles = [...new Set([...semanticRepairFiles, ...repaired.editedPaths])];
        repairTask.producedFiles = repaired.editedPaths;
        repairTask.status = repaired.stoppedReason
          ? repaired.editedPaths.length > 0
            ? "partial"
            : "failed"
          : workerFailedToProduceChanges(repaired) ||
              failedLeafVerificationResults(repairTask, repaired).length > 0
            ? "failed"
            : "done";
      } catch {
        repairTask.status = "failed";
        repairTask.producedFiles = [];
      }
      done.push(repairTask);
    };

    if (semanticEnabled) {
      this.notice("◆ Semantic acceptance: verifying the repository against the approved plan.");
      semanticReport = await verifySemantics();
      if (!semanticReport) {
        semanticNeedsRecheck = true;
        this.notice("✗ Semantic verifier did not return a valid evidence report.", "warn");
      } else if (semanticReport.verdict === "fail" && !signal.aborted) {
        this.notice(`Semantic verifier: ${semanticReport.summary}`, "warn");
        semanticNeedsRecheck = true;
        await repairSemantics(semanticReport);
      }
    }
    // Deterministic integration check: catch cross-worker wiring gaps (e.g. Tailwind v4 installed
    // but its Vite plugin never wired). One bounded corrective worker pass, then re-check.
    const fixEntries = this.deps.listDir ? await this.deps.listDir(buildPath) : null;
    const fixCtx = {
      anchor: renderLocationAnchor(plan.location, this.deps.projectDir ?? "", { scaffold: false }),
      onDiskSnapshot: fixEntries ? describeOnDisk(fixEntries) : "",
      doneEntries: taskOutcomeEntries(done),
      upcomingTitles: [] as string[],
    };
    if (!signal.aborted && this.deps.inspectProject) {
      const violations = await this.deps.inspectProject(signal);
      if (violations.length > 0 && !signal.aborted) {
        semanticNeedsRecheck = semanticEnabled;
        this.notice(
          `Integration check found ${violations.length} wiring issue(s); attempting a fix.`,
          "warn",
        );
        for (const v of violations) {
          if (signal.aborted) break;
          const fixTask: PlanTask = {
            id: `fix-${v.rule}`,
            title: `Fix: ${v.problem}`,
            description: v.fix,
            agentType: "general",
            status: "running",
          };
          try {
            await this.runWorker(
              fixTask,
              brief,
              signal,
              workerSeed,
              fixCtx,
              this.deps.spawnRecoveryWorker ?? this.deps.spawnWorker,
            );
          } catch {
            /* the re-check below reports whether it stuck */
          }
        }
        const remaining = signal.aborted ? [] : await this.deps.inspectProject(signal);
        this.notice(
          remaining.length === 0
            ? "Integration check: wiring issues resolved."
            : `Integration check: ${remaining.length} issue(s) remain after the fix attempt.`,
          remaining.length === 0 ? "info" : "warn",
        );
      }
    }
    // Deterministic build/coherence gate: verify the project actually builds (not just that files
    // exist). On failure, bounded corrective worker passes; report the outcome honestly. Runs AFTER
    // the static integration check (those traps would themselves fail the build). #162.
    let buildOutcome: BuildGateResult | null | undefined;
    let buildFixFiles: string[] = [];
    const runBuildGate = async (): Promise<void> => {
      if (signal.aborted || !this.deps.verifyBuild) return;
      const fix = async (errorTail: string, sig: AbortSignal): Promise<void> => {
        try {
          const entries = this.deps.listDir ? await this.deps.listDir(buildPath) : null;
          const fixed = await this.runWorker(
            {
              id: "build-fix",
              title: "Fix build errors",
              description: buildFixDescription({
                errorTail,
                objective,
                approvedPlan,
                semanticReport,
              }),
              agentType: "general",
              status: "running",
            },
            brief,
            sig,
            workerSeed,
            {
              anchor: renderLocationAnchor(plan.location, this.deps.projectDir ?? "", {
                scaffold: false,
              }),
              onDiskSnapshot: entries ? describeOnDisk(entries) : "",
              doneEntries: taskOutcomeEntries(done),
              upcomingTitles: [],
            },
            this.deps.spawnRecoveryWorker ?? this.deps.spawnWorker,
          );
          buildFixFiles = [...new Set([...buildFixFiles, ...fixed.editedPaths])];
        } catch {
          /* the rebuild below reports whether it stuck */
        }
      };
      const res = await this.deps.verifyBuild(fix, signal);
      buildOutcome = res;
      if (res?.outcome === "passed") {
        this.notice("Build check: project builds cleanly.");
      } else if (res?.outcome === "fixed") {
        semanticNeedsRecheck = semanticEnabled;
        this.notice(
          `Build check: fixed build error(s) after ${res.fixRounds} correction round(s).`,
        );
      } else if (res?.outcome === "failing") {
        this.notice(
          `Build check: still failing after ${res.fixRounds} correction round(s):\n${res.finalErrorTail ?? ""}`,
          "warn",
        );
      }
    };
    await runBuildGate();
    if (semanticEnabled) {
      if (semanticNeedsRecheck && !signal.aborted) {
        this.notice("◆ Semantic acceptance: rechecking the repository after corrective edits.");
        semanticReport = await verifySemantics();
      }
      if (semanticReport?.verdict === "fail" && !semanticRepairUsed && !signal.aborted) {
        this.notice(
          "◇ Final semantic recheck found unmet requirements; using the remaining repair pass.",
          "warn",
        );
        await repairSemantics(semanticReport);
        // A post-build semantic repair may affect compilation. Re-run the mechanical gate before
        // accepting its semantic result, then inspect the repository one last time.
        await runBuildGate();
        this.notice("◆ Semantic acceptance: verifying the post-repair repository.");
        semanticReport = await verifySemantics();
      }
      const semanticTask: PlanTask = {
        id: "integration-final",
        title: "Verify the approved plan against the final repository",
        description: semanticReport
          ? renderSemanticReport(semanticReport)
          : "The semantic verifier did not produce a valid evidence report for the final repository.",
        agentType: "explore",
        status: semanticReport?.verdict === "pass" ? "done" : "failed",
        producedFiles: [...new Set([...semanticRepairFiles, ...buildFixFiles])],
      };
      done.push(semanticTask);
      this.notice(
        semanticTask.status === "done"
          ? "✓ Semantic acceptance passed with repository evidence."
          : `✗ Semantic acceptance failed; ${semanticReport?.summary ?? "the verifier did not return valid evidence"}`,
        semanticTask.status === "done" ? "info" : "warn",
      );
    }
    const semanticPassed = semanticReport?.verdict === "pass";
    const complete =
      buildOutcome?.outcome !== "failing" &&
      (semanticEnabled
        ? semanticPassed
        : pending.length === 0 && done.every((task) => task.status === "done"));
    // A model-written closing can add useful voice to a successful run, but it must never soften
    // or contradict a deterministic failure (codex12 called a disconnected UI "largely in place"
    // after semantic acceptance failed). Incomplete runs get an authoritative mechanical close and
    // skip one unnecessary model call.
    let summaryText = "";
    if (complete) {
      const overlay = this.deps.voiceOverlay?.() ?? "";
      const closingSystem = overlay ? `${CLOSING_SYSTEM}\n\n${overlay}` : CLOSING_SYSTEM;
      summaryText = (
        await callModel(orchestratorModel(), closingSystem, closingUser(brief, done), signal)
      ).trim();
    }
    const failed = done.filter((t) => t.status === "failed").length;
    const failedNote = failed ? `, ${failed} failed` : "";
    const reachedNote = pending.length ? `, ${pending.length} not reached.` : ".";
    const fallbackSummary = `Orchestration finished: ${done.length} task(s) executed${failedNote}${reachedNote}`;
    const facts = renderOrchestrationOutcome(done, pending.length);
    const authoritativeFailure = semanticEnabled
      ? `Final result: incomplete. Semantic acceptance did not pass. ${semanticReport?.summary ?? "The verifier did not return a valid evidence report."}`
      : buildOutcome?.outcome === "failing"
        ? `Final result: incomplete. The deterministic build gate is still failing. ${buildOutcome.finalErrorTail ?? ""}`.trim()
        : `Final result: incomplete. ${fallbackSummary}`;
    const prose = complete
      ? summaryText.length > 0
        ? summaryText
        : fallbackSummary
      : authoritativeFailure;
    this.deps.recordSummary(`${facts}\n\n${prose}`);
    return { kind: "ran", complete };
  }

  async run(args: RunArgs): Promise<RunResult> {
    const plan = await this.structure(args);
    if (!plan) {
      this.noticeStructureFailure();
      return { kind: "fallback" };
    }
    return this.execute(plan, args.signal);
  }

  private async runWorker(
    task: PlanTask,
    brief: string,
    signal: AbortSignal,
    seedReminders: string[],
    ctx: {
      anchor: string;
      onDiskSnapshot: string;
      doneEntries: TaskOutcomeEntry[];
      upcomingTitles: string[];
    },
    spawn: SpawnWorker = this.deps.spawnWorker,
    behavior: { protocolOutput?: boolean; convergeEarly?: boolean } = {},
  ): Promise<{
    assistantText: string;
    successfulEdits: number;
    failedWrites: number;
    stoppedReason?:
      | "loop_limit"
      | "token_budget"
      | "time_budget"
      | "thrash"
      | "hidden_tools"
      | "no_progress"
      | "premature_completion"
      | "stream_watchdog"
      | "permission_error"
      | "provider_error"
      | "cancelled";
    editedPaths: string[];
    verificationResults: VerificationResult[];
    progressSummary?: string;
    budgetExtensions?: number;
  }> {
    const acceptance = task.acceptanceCriteria?.length
      ? `\n\n## Acceptance criteria (prove these before claiming completion)\n${task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`
      : "";
    const baselineProtocol = /baseline|pre-existing|preexisting/i.test(
      `${task.description}\n${(task.acceptanceCriteria ?? []).join("\n")}`,
    )
      ? "\n\n## Baseline verification protocol\nRun the current verification normally. Run the starting-revision comparison in a clean isolated temporary copy/worktree and prefix ONLY that isolated command with `CLEETUS_VERIFICATION_BASELINE=1`. Never use git stash/reset/checkout on the user's working tree. The runtime compares parsed failing test identities; prose alone does not establish a baseline."
      : "";
    const prompt = composeWorkerPrompt({
      anchor: ctx.anchor,
      onDiskSnapshot: ctx.onDiskSnapshot,
      doneEntries: ctx.doneEntries,
      taskDescription: `${task.description}${acceptance}${baselineProtocol}`,
      upcomingTitles: ctx.upcomingTitles,
      brief,
    });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.deps.config.maxTaskRetries; attempt++) {
      if (signal.aborted) throw new Error("aborted");
      try {
        const r = await spawn({
          type: task.agentType,
          prompt,
          signal,
          taskId: task.id,
          title: task.title,
          pendingTitles: ctx.upcomingTitles,
          ownedPaths: taskOwnedPaths(task),
          seedReminders,
          protocolOutput: behavior.protocolOutput,
          convergeEarly: behavior.convergeEarly,
        });
        return {
          assistantText: r.assistantText,
          successfulEdits: r.successfulEdits,
          failedWrites: r.failedWrites,
          stoppedReason: r.stoppedReason,
          editedPaths: r.editedPaths,
          verificationResults: r.verificationResults ?? [],
          progressSummary: r.progressSummary,
          budgetExtensions: r.budgetExtensions,
        };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
