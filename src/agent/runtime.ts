import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ulid } from "ulid";
import type { CheckpointRecorder } from "../checkpoint/types";
import { type ContextConfig, DEFAULT_CONTEXT } from "../config/context";
import { capCheckpointNote } from "../config/loop-cap";
import type { LoopGuardConfig } from "../config/loop-guard";
import type { MalformedPathConfig } from "../config/malformed-path";
import type { PlanModeGuardConfig } from "../config/plan-mode";
import { DEFAULT_STREAM_WATCHDOG, type StreamWatchdogConfig } from "../config/stream-watchdog";
import type { ModelFamilyConfig, ModelProfile } from "../config/types";
import type { EventSink } from "../events/types";
import { formatNotice } from "../format/manager";
import type { Formatter } from "../format/types";
import type { HookEngine } from "../hooks";
import { playbookSuggestionText, shouldSuggestPlaybook } from "../learn/suggest";
import { CleetusError } from "../lib/errors";
import { unexpectedCleetusProjectReference } from "../permission/cross-project";
import { detectMalformedToolPath, extractGuardedPath } from "../permission/malformed-path";
import { pathEscapesProject, rawToolPath, resolveReadTarget } from "../permission/path-guard";
import type { Decision } from "../permission/types";
import { PATH_READING_TOOLS, PATH_WRITING_TOOLS } from "../permission/types";
import { stripToolCallMarkup } from "../providers/families";
import type { ProviderRegistry } from "../providers/registry";
import {
  NoResponseFormatMemo,
  isNoResponseFormatError,
  toolCallEnvelope,
} from "../providers/structured-output";
import type {
  ChatOptions,
  ImageRef,
  Message,
  Provider,
  ToolSchema,
  WindowInfo,
} from "../providers/types";
import type { VisionSupport } from "../providers/vision";
import type { ToolDispatcher } from "../tools/dispatcher";
import type { ToolRegistry } from "../tools/registry";
import { renderTodoLines } from "../tools/todo-write";
import type { TodoItem, ToolResult } from "../tools/types";
import { validateToolArgs } from "../tools/validate-args";
import { acceptanceReminder, originalUserRequests } from "./acceptance";
import {
  artifactIdentityAnchor,
  expectsExactFetchedArtifact,
  fetchedArtifactIdentityGrounded,
  fetchedJsonBody,
  fetchedJsonUrlsFromEvidence,
  jsonFidelityIssues,
  parseJsonDestination,
} from "./artifact-fidelity";
import { locationGroundingReminder, scanProject } from "./bootstrap-location";
import {
  type Capability,
  type CapabilityMode,
  EXACT_ARTIFACT_TOOL_ROSTER,
  SMALL_RETRIEVAL_TOOL_ROSTER,
  SMALL_TOOL_ROSTER,
  decideCapability,
  filterToolsForCapability,
  hiddenToolRedirect,
} from "./capability";
import { isImplementationPath } from "./change-kind";
import {
  classifyTask,
  isCodingTask,
  reportsInteractiveRenderDefect,
  reportsRuntimeDefect,
  requiresRenderEvidence,
} from "./coding-task";
import {
  type EditedFileSnapshot,
  appendCompletionEvidenceQualification,
  completionAuditInspectionPath,
  completionAuditReminder,
  completionAuditScopeBlock,
  hasImplementationChanges,
  isTestPath,
  shouldRunCompletionAudit,
  testCoverageRegressions,
  testEvidenceWeaknesses,
  unsupportedCompletionClaims,
} from "./completion-audit";
import {
  budgetBase,
  budgetUpgradeNotice,
  computeBudget,
  estimateTokens,
  normalizeContextLength,
  safeAssembledInputLimit,
} from "./context/budget";
import {
  DIGEST_SYSTEM_PROMPT,
  type DigestState,
  SummaryTimeoutError,
  buildDigestMessage,
  compact,
  renderSliceForSummary,
} from "./context/digest";
import { slimDeepHistory } from "./context/slim";
import {
  computeRecentBoundary,
  liveTurnStart,
  messageTokens,
  protectFreshestToolResult,
  sumTokens,
} from "./context/window";
import { DEFAULT_EFFORT, type EffortLevel, applyEffort } from "./effort";
import {
  finishPassErrorNotice,
  reasoningHasToolCallMarkup,
  selectTurnEndNotice,
} from "./empty-turn";
import {
  currentTurnEvidence,
  groundedSynthesisMessages,
  synthesisGroundingIssues,
} from "./grounded-synthesis";
import { LoopGuard, RepeatedProbeGuard, repeatedProbeRecoveryAdvice } from "./loop-guard";
import {
  FORCE_PLAN_SYNTHESIS_PROMPT,
  PLAN_APPROVAL_MESSAGE,
  PLAN_MODE_REMINDER,
  approvedPlanStepTitles,
  isMutating,
  planModeDenial,
} from "./plan-mode";
import { SessionReadCache } from "./read-cache";
import { blocksRecreate, pathExistsNonEmpty, recreateBlockMessage } from "./recreate-guard";
import {
  REPETITION_CHECK_INTERVAL,
  REPETITION_TAIL_CHARS,
  ReasoningCycleDetector,
  ReasoningLoopDetector,
  detectRepetition,
} from "./repetition";
import {
  dataArtifactInventoryNudge,
  downloadRequest,
  redundantFetchedJsonDownloadBlock,
  retrievalDiscoveryStalled,
  retrievalEfficiencyKind,
  retrievalEfficiencyReminder,
  retrievalFetchNudge,
  retrievalMissNudge,
  retrievalRecoveryReminder,
  retrievalToolMadeProgress,
  retrievalUrlCoordinatesGrounded,
  successfulFetchedJsonEvidence,
  ungroundedRetrievalCoordinateBlock,
} from "./retrieval-efficiency";
import type { RouteDecision, Router } from "./router";
import {
  protectedControlPath,
  protectedControlPathMessage,
  protectedInfrastructureBlock,
  protectedPackageCommandBlock,
  protectedScopeBlockMessage,
  scopeBlockMessage,
  scopeCreepBlock,
} from "./scope-guard";
import type { ModelChoice, TurnContext, TurnRoutingHints } from "./selector";
import type { SessionHistoryStore } from "./session-history";
import { stickyReminders } from "./sticky-reminders";
import {
  type SeededTodoContract,
  missingExpectedFiles,
  missingVerificationEvidence,
  observedTodoPhaseTransition,
  seededTodoContract,
  todoTransitionSatisfied,
} from "./todo-progress";
import { renderTodoReminder } from "./todo-reminder";
import type { ResolvePermission, RunTurnResult, VerificationResult } from "./types";
import { versionPinReminderFor } from "./version-pin";

/** Outcome of a tool-less finish/synthesis pass. `ok` carries the synthesized text; `empty`
 *  covers both a blank response and a markup-contaminated one (caller falls back); `error`
 *  is a provider failure (the caller decides whether to surface it or fall back silently);
 *  `aborted` means the user cancelled mid-call. */
type FinishPassResult =
  | { status: "ok"; text: string }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "aborted" };

/** Matches server error text for a model that emitted an invalid tool call (the server
 * couldn't parse the call's JSON arguments). Used only to tailor the retry nudge/notice. */
const TOOL_CALL_PARSE_RE = /parsing tool call|invalid character/i;

/** Read-only inventory tools where several known-independent calls can usually share a model
 * round. The nudge using this set is advisory and fires at most once per turn. */
const BATCHABLE_INSPECTION_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "git_status",
  "git_diff",
  "git_log",
]);
const SINGLE_INSPECTION_BATCH_NUDGE_ROUNDS = 4;

/** Shell commands that are repository inspection, not mutation or verification. This deliberately
 * accepts only a small command vocabulary and rejects shell control constructs whose later command
 * could mutate state. */
export function isBatchableInspectionCall(name: string, args: unknown): boolean {
  if (BATCHABLE_INSPECTION_TOOLS.has(name)) return true;
  if (name !== "bash") return false;
  const command = (args as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  const text = command.trim();
  if (!text || /(?:&&|\||;|\n|>|<|`|\$\()/.test(text)) return false;
  return /^(?:pwd\b|ls\b|tree\b|rg\b|grep\b|sed\s+-n\b|head\b|tail\b|wc\b|stat\b|git\s+(?:status|diff|log|show)\b)/i.test(
    text,
  );
}

/** A transient server or stream failure is safe to resample once — no tool has run yet. */
function isRetryableProviderError(e: unknown): boolean {
  return e instanceof CleetusError && e.retryable;
}

/** Ollama rejects a reasoning request to a non-thinking model with a 400 "does not support
 * thinking". Detect it so we can resample once with reasoning_effort stripped. */
export function isNoThinkingError(e: unknown): boolean {
  return (
    e instanceof CleetusError &&
    e.code === "PROVIDER_INVALID_RESPONSE" &&
    /does not support thinking/i.test(e.message)
  );
}

/** Thrown by streamCall when the stream watchdog (not the user) aborts a call. `kind`
 *  distinguishes a pre-first-token stall, a mid-stream idle stall, the absolute-ceiling
 *  runaway backstop, mid-stream degenerate repetition, a reasoning rumination loop, and an
 *  exact long reasoning cycle. */
export class StreamWatchdogError extends Error {
  constructor(
    readonly limitMs: number,
    readonly kind:
      | "idle"
      | "ceiling"
      | "first_token"
      | "repetition"
      | "rumination"
      | "reasoning_cycle",
  ) {
    super(`model call aborted by ${kind} watchdog after ${limitMs}ms`);
    this.name = "StreamWatchdogError";
  }
}

/** A one-off correction appended only to the retry's messages (never persisted) when a
 * failure looks like an invalid tool call, nudging the model to emit valid JSON. */
function toolCallParseNudge(e: unknown): Message | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (!TOOL_CALL_PARSE_RE.test(msg)) return null;
  return {
    role: "system",
    content:
      "Your previous reply contained an invalid tool call: the arguments were not valid JSON. " +
      "Re-issue the tool call using only the documented parameters, with valid JSON arguments.",
  };
}

/** A one-off correction appended only to the empty-turn retry's messages (never persisted)
 * when the first attempt emitted its tool call inside the reasoning channel — the single
 * most common small-model empty-turn cause. Mirrors toolCallParseNudge's mechanics. */
const REASONING_MARKUP_NUDGE: Message = {
  role: "system",
  content:
    "Your previous reply put a tool call inside your reasoning channel, so it was not executed. " +
    "Re-issue it as a real tool call with valid JSON arguments — do not write it in your reasoning or prose.",
};

const INTENT_ONLY_TAIL =
  /^(?:(?:now|next)[,:]?\s+)?(?:let me\b|i(?:'ll|\s+will|\s+need to|\s+should|\s+am going to)\b)/i;
const BARE_NEXT_ACTION_TAIL =
  /^(?:now|next)[,:]?\s+(?:add|build|check|clean|create|delete|edit|fix|implement|inspect|move|read|remove|rename|run|test|update|verify|wire|write)\b/i;

/** A provider `stop` is not necessarily task completion. Some models end on a narration such as
 * "Let me inspect..." even though their own todo list still has work. Keep this deliberately
 * narrow and require both prior tool use and unfinished durable todos; ordinary conversational
 * answers and final summaries remain terminal. */
export function prematureImplementationStop(input: {
  text: string;
  usedTools: boolean;
  unfinishedTodos: number;
}): "empty" | "intent" | null {
  if (!input.usedTools || input.unfinishedTodos <= 0) return null;
  const clean = input.text.trim();
  if (!clean) return "empty";
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const tail = sentences.at(-1)?.trim() ?? clean;
  return INTENT_ONLY_TAIL.test(tail) || BARE_NEXT_ACTION_TAIL.test(tail) ? "intent" : null;
}

/** A substantive final response can still be premature when it declares the whole task complete
 * while the model's own durable checklist says otherwise. Keep this narrower than general success
 * detection: partial-progress summaries and honest incomplete handoffs must remain terminal. */
export function claimsCompletionWithUnfinishedTodos(input: {
  text: string;
  usedTools: boolean;
  unfinishedTodos: number;
}): boolean {
  if (!input.usedTools || input.unfinishedTodos <= 0) return false;
  const clean = input.text.trim();
  if (!clean) return false;
  if (
    /\b(?:not|isn't|wasn't|aren't|weren't)\s+(?:done|complete|completed|finished|implemented|verified)\b/i.test(
      clean,
    )
  ) {
    return false;
  }
  return (
    /\b(?:all|everything)\b.{0,80}\b(?:done|complete(?:d)?|finished|implemented|verified|pass(?:es|ed)?)\b/is.test(
      clean,
    ) ||
    /\b(?:implementation|work|task|feature)\b.{0,50}\b(?:is|was|has been)?\s*(?:done|complete(?:d)?|finished|implemented|verified)\b/is.test(
      clean,
    ) ||
    /\b(?:done|complete|completed|finished)\b[.!]?\s*$/i.test(clean)
  );
}

/** An explicit partial-progress handoff is not a stale checklist: the final answer and tracker
 * agree that work remains. Keep these terminal so bounded plan steps and honest blockers do not
 * pay for a no-op reconciliation pass. */
export function reportsUnfinishedTodoWork(text: string): boolean {
  // Negated limitations assert completion. In ccweb3, "nothing left unfinished" bypassed
  // reconciliation even though the authoritative working list was still 5/7.
  const limitations = text.replace(
    /\b(?:nothing|none)(?:\s+is)?(?:\s+left)?\s+(?:unfinished|incomplete|remaining|pending|blocked)\b|\bno\s+(?:unfinished|incomplete|remaining|pending|blocked)(?:\s+(?:work|tasks?|items?|todos?))?\b|\bno\s+(?:work|tasks?|items?|todos?)(?:\s+(?:is|are|remains?))?\s+(?:unfinished|incomplete|remaining|pending|blocked|remains?)\b/gi,
    "",
  );
  return /\b(?:unfinished|incomplete|remaining|pending|blocked)\b|\b(?:work|task|todo(?:s| list)?|verification|step)\s+remain(?:s|ing)?\b|\blater\s+work\s+remains?\b|\b(?:not|isn't|wasn't|aren't|weren't|did not)\s+(?:done|complete(?:d)?|finished|implemented|verified)\b/i.test(
    limitations,
  );
}

function unfinishedTodoCount(todos: TodoItem[] | undefined): number {
  return (todos ?? []).filter((todo) => todo.status !== "completed").length;
}

/** A single deliver-and-qualify limitation line naming the still-open todos. Used when the model
 * claims completion with unfinished todos and one reconciliation retry does not close them: rather
 * than discard a buildable result, deliver it and record the open items as an honest limitation. */
function unfinishedTodoQualification(todos: TodoItem[] | undefined): string {
  const open = (todos ?? []).filter((todo) => todo.status !== "completed");
  const shown = open.slice(0, 6).map((todo) => todo.content.replace(/\s+/g, " ").trim());
  const suffix = open.length > shown.length ? `, and ${open.length - shown.length} more` : "";
  const noun = open.length === 1 ? "item remains" : "items remain";
  return `${open.length} planned todo ${noun} unfinished or unverified: ${shown.join("; ")}${suffix} — the rest of the implementation was delivered; complete or verify ${open.length === 1 ? "it" : "them"} before relying on the result.`;
}

function prematureStopNudge(unfinished: number, kind: "empty" | "intent"): Message {
  return {
    role: "user",
    content: `<system-reminder>Your implementation turn is not complete: your working todo list still has ${unfinished} unfinished item${unfinished === 1 ? "" : "s"}, and your previous response ${kind === "empty" ? "was empty" : "only announced a next action"}. Continue the work now. If it is actually complete, run the required focused verification, update the todo list, and return a concrete final summary. Do not stop on another transition sentence.</system-reminder>`,
  };
}

/** Injected once per turn after a reasoning-cycle / rumination watchdog abort, to break a
 *  decision-deliberation loop: the model oscillated over a choice without acting (ctest q38-1 —
 *  keep-vs-revert an audit edit, byte-identical, until the watchdog stopped it). A cold halt here
 *  forced a manual "continue" that just re-entered the same loop, so instead we tell the model to
 *  commit and take one concrete action, then retry the call. */
function loopBreakNudge(): Message {
  return {
    role: "user",
    content:
      "<system-reminder>You were stopped because you repeated the same reasoning without taking action — you were weighing a decision back and forth. You have already reasoned it through; do not re-derive that trade-off. Commit to the decision now and take exactly ONE concrete next action: run a command, make an edit, or write your final summary. Do not deliberate about this choice again.</system-reminder>",
  };
}

/** Wall-clock ceiling (ms) for a turn: applies only to orchestration workers; 0 = unlimited. Pure. */
export function turnDeadlineMs(source: string, workerTurnMs: number | undefined): number {
  return source === "orchestration-worker" ? (workerTurnMs ?? 0) : 0;
}

/** Number of read/search-only tool rounds a general orchestration worker gets before a single
 *  recency-positioned instruction tells it to begin editing. */
export const WORKER_EDIT_NUDGE_ROUNDS = 4;

/** Estimate NEW work since the preceding model call for the no-progress guard. Provider usage
 *  reports the entire input context on every call, so summing input+output repeatedly counts the
 *  same prompt/history many times and prematurely kills tool-using workers. The initial prompt is
 *  treated as setup; later positive input growth plus generated output approximates novel work.
 *  A context compaction simply establishes a new, lower baseline for the following call. */
export function incrementalProgressTokens(
  usage: { input: number; output: number },
  previousInput: number | undefined,
): number {
  const inputGrowth = previousInput === undefined ? 0 : Math.max(0, usage.input - previousInput);
  return inputGrowth + Math.max(0, usage.output);
}

/** Identify explicit verification commands whose final result is part of task completion. Keep
 *  ordinary exploratory bash calls out: only test/build/lint/typecheck families are tracked. */
export function verificationCommandKey(tool: string, args: unknown): string | null {
  const record = (args ?? {}) as Record<string, unknown>;
  if (tool === "render_check") {
    const command = typeof record.command === "string" ? record.command.trim() : "";
    if (command) return `render_check:suite:${command.replace(/\s+/g, " ")}`;
    const norm = (value: unknown) =>
      typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    const launchCommand = norm(record.launchCommand).replace(
      /(\s--port(?:=|\s+))\d+\b/gi,
      "$1<port>",
    );
    let url = typeof record.url === "string" ? record.url.trim() : "";
    try {
      const parsed = new URL(url);
      if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
        url = `${parsed.protocol}//${parsed.hostname}:<port>${parsed.pathname}${parsed.search}`;
      }
    } catch {
      // Keep malformed/missing values distinct so argument-shape failures stay actionable.
    }
    // The assertion (expectedText / expectedControl / expectedAfterText) is part of the check's
    // identity: two probes of the same route asserting different things are different verifications.
    // Excluding it made the cache serve a stale result for a changed assertion (and could serve a
    // false pass), so include the normalized assertion in the key.
    const assertion =
      [norm(record.expectedText), norm(record.expectedControl), norm(record.expectedAfterText)]
        .filter(Boolean)
        .join(" | ") || "(no-assertion)";
    return `render_check:launch:${launchCommand || "(missing)"}->${url || "(missing)"}::${assertion}`;
  }
  if (tool === "smoke_run") {
    const command = typeof record.command === "string" ? record.command.trim() : "";
    return command ? `smoke_run:${command.replace(/\s+/g, " ")}` : "smoke_run:default";
  }
  if (tool === "run_tests") {
    if (typeof record.check === "string" && record.check !== "test")
      return `run_tests:check:${record.check}`;
    const filter = typeof record.filter === "string" ? record.filter.trim() : "";
    return `run_tests:${filter || "full"}`;
  }
  if (tool !== "bash") return null;
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!command) return null;
  const verification =
    /\b(?:bun\s+test|bun\s+run\s+(?:test|lint|typecheck|build)|bunx\s+(?:tsc|vitest(?:\s+run)?|jest|playwright\s+test|cypress\s+run|mocha|ava|eslint|biome\s+check)|tsc\s+--noEmit|pytest|uv\s+run\s+pytest|cargo\s+test|go\s+test|swift\s+test|swift\s+build|xcodebuild)\b/i;
  if (!verification.test(command)) return null;
  // Track the actual quality command, not output shaping/cleanup around it. This lets a later
  // GREEN rerun clear an earlier RED even when the model changes `tail`, redirection, or spacing.
  const quality = command.match(
    /\b(?:bun\s+test(?:\s+[^;&|\n]+)?|bun\s+run\s+(?:test|lint|typecheck|build)(?:\s+[^;&|\n]+)?|bunx\s+(?:tsc|vitest(?:\s+run)?|jest|playwright\s+test|cypress\s+run|mocha|ava|eslint|biome\s+check)(?:\s+[^;&|\n]+)?|tsc\s+--noEmit(?:\s+[^;&|\n]+)?|uv\s+run\s+pytest(?:\s+[^;&|\n]+)?|pytest(?:\s+[^;&|\n]+)?|cargo\s+test(?:\s+[^;&|\n]+)?|go\s+test(?:\s+[^;&|\n]+)?|swift\s+(?:test|build)(?:\s+[^;&|\n]+)?|xcodebuild(?:\s+[^;&|\n]+)?)/i,
  )?.[0];
  const normalized = (quality ?? command)
    .replace(/\s+\d*(?:>>?|<<?)&?\d*.*$/g, "")
    .replace(/\s+--(?:reporter|color|colors)(?:=[^\s]+|\s+[^\s-]+)?|\s+--no-colors?/g, "")
    .trim()
    .replace(/\s+/g, " ");
  const baseline = /\bCLEETUS_VERIFICATION_BASELINE=1\b/.test(command);
  return `bash:${normalized}${baseline ? ":baseline" : ""}`;
}

export function verificationEvidence(tool: string, args: unknown): VerificationResult["evidence"] {
  const record = (args ?? {}) as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command : "";
  if (tool === "render_check" || /\b(?:playwright\s+test|cypress\s+run)\b/i.test(command)) {
    return "render";
  }
  if (tool === "smoke_run") return "launch";
  if (tool === "run_tests" && record.check && record.check !== "test") return "quality";
  if (
    tool === "run_tests" ||
    /\b(?:bun\s+test|bun\s+run\s+test|bunx\s+(?:vitest|jest|mocha|ava)|pytest|cargo\s+test|go\s+test|swift\s+test)\b/i.test(
      command,
    )
  ) {
    return "test";
  }
  return "quality";
}

export function verificationSucceeded(tool: string, toolOk: boolean, detail: string): boolean {
  if (!toolOk) return false;
  if (tool !== "smoke_run") return true;
  return /^(?:✓|⏱)/m.test(detail) && !/^[✗⚠]/m.test(detail);
}

export function verificationClosesSourceLease(
  evidence: VerificationResult["evidence"],
  key: string,
): boolean {
  return evidence === "test" || evidence === "render" || /\bbuild\b/i.test(key);
}

/** Extract stable failure identities from common test-runner output. Timing/count noise is
 * deliberately excluded so current and isolated-baseline runs can be compared exactly. */
export function verificationFailureIds(detail: string): string[] {
  const ids = new Set<string>();
  for (const line of detail.split("\n")) {
    const trimmed = line.trim();
    const bun = trimmed.match(/^\(fail\)\s+(.+?)(?:\s+\[\d.*\])?$/i)?.[1];
    const pytest = trimmed.match(/^FAILED\s+(.+?)(?:\s+-\s+.*)?$/)?.[1];
    const generic = trimmed.match(/^test\s+(.+?)\s+\.\.\.\s+FAILED$/i)?.[1];
    const id = bun ?? pytest ?? generic;
    if (id) ids.add(id.trim());
  }
  return [...ids].sort();
}

const MAX_VERIFICATION_FAILURE_CHARS = 6000;

/** Keep verification evidence useful without replaying an entire Bash test/lint transcript on
 * every later model call. The raw ToolResult is still written to the event log before this is
 * used; this shapes only the model-facing history entry. `run_tests` already performs its own
 * runner-aware compaction, so the runtime uses this for Bash-based verification commands. */
export function compactVerificationForModel(command: string, ok: boolean, detail: string): string {
  if (ok) {
    const summaries = detail
      .split("\n")
      .map((line) => line.trim())
      .filter((line) =>
        /^(?:\d+\s+(?:pass|fail|skip)(?:es)?\b|Ran\s+\d+\s+tests?\b|Tests?:\s)/i.test(line),
      )
      .slice(-6);
    return [`✓ verification passed: ${command}`, ...summaries].join("\n");
  }

  const failureIds = verificationFailureIds(detail);
  const identities = failureIds.length
    ? `Failing checks:\n${failureIds.map((id) => `- ${id}`).join("\n")}\n`
    : "";
  const tail =
    detail.length <= MAX_VERIFICATION_FAILURE_CHARS
      ? detail
      : `… [${detail.length - MAX_VERIFICATION_FAILURE_CHARS} earlier chars omitted]\n${detail.slice(
          -MAX_VERIFICATION_FAILURE_CHARS,
        )}`;
  return `✗ verification failed: ${command}\n${identities}${tail}`;
}

function renderProgressSummary(args: {
  editedPaths: string[];
  recentActions: string[];
  lastNarration: string;
  latestDiagnostics: string;
  verificationResults: VerificationResult[];
}): string | undefined {
  const parts: string[] = [];
  if (args.editedPaths.length > 0) parts.push(`Files changed: ${args.editedPaths.join(", ")}`);
  if (args.recentActions.length > 0)
    parts.push(`Recent durable actions:\n${args.recentActions.map((x) => `- ${x}`).join("\n")}`);
  if (args.latestDiagnostics)
    parts.push(`Latest diagnostics:\n${args.latestDiagnostics.slice(-2000)}`);
  const checks = args.verificationResults.map(
    (result) => `- ${result.ok ? "pass" : "fail"}: ${result.command}`,
  );
  if (checks.length > 0) parts.push(`Verification state:\n${checks.join("\n")}`);
  if (args.lastNarration)
    parts.push(`Worker's last stated next step:\n${args.lastNarration.slice(-1000)}`);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** A verification shell command is not trustworthy when it prints `$?` in a later command: the
 *  trailing echo/printf becomes the shell's exit status and can erase the test/build failure. */
export function verificationCommandMasksExit(tool: string, args: unknown): boolean {
  if (tool !== "bash") return false;
  const command = (args ?? {}) as Record<string, unknown>;
  if (typeof command.command !== "string") return false;
  const text = command.command;
  const quality =
    /\b(?:bun\s+test|bun\s+run\s+(?:test|lint|typecheck|build)|bunx\s+(?:tsc|vitest(?:\s+run)?|jest|playwright\s+test|cypress\s+run|mocha|ava|eslint|biome\s+check)|tsc\s+--noEmit|pytest|uv\s+run\s+pytest|cargo\s+test|go\s+test|swift\s+(?:test|build)|xcodebuild)\b/i;
  const start = text.search(quality);
  if (start < 0) return false;
  const tail = text.slice(start);
  // A pipeline is safe because the bash tool enables pipefail. A later command/list is not: its
  // status replaces the verifier's unless the script explicitly captures and exits with it.
  const hasLaterList = /(?:;|\n|&&|\|\|)\s*\S/.test(tail);
  if (!hasLaterList) return false;
  const preservesStatus =
    /(?:status|code|rc)=\$\?/.test(tail) &&
    /\bexit\s+\$(?:\{)?(?:status|code|rc)(?:\})?\b/.test(tail);
  return !preservesStatus;
}

/** Cache a verifier, never a surrounding shell program. A normalized quality key is useful
 * for reconciling RED/GREEN checks but cannot authorize skipping `cp`, `rm`, or setup around it. */
export function verificationReplayContext(tool: string, args: unknown): string | null {
  const record = (args ?? {}) as Record<string, unknown>;
  if (tool !== "bash") return JSON.stringify(record);
  if (typeof record.command !== "string") return null;
  let command = record.command.trim();
  if (/[`$\n]/.test(command)) return null;
  const cd = command.match(/^cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/);
  if (cd) command = command.slice(cd[0].length);
  // Quoted output-filter arguments may contain pipes; they are not shell operators.
  const syntax = command.replace(/'[^']*'|"[^"]*"/g, "argument").replace(/2>&1/g, "");
  if (/[;&<>]/.test(syntax)) return null;
  const segments = syntax.split("|").map((segment) => segment.trim());
  if (
    !/^(?:bun\s+(?:test|run\s+(?:test|lint|typecheck|build))|bunx\s+(?:tsc|vitest|jest|playwright|cypress|mocha|ava|eslint|biome)|tsc|pytest|uv\s+run\s+pytest|cargo\s+test|go\s+test|swift\s+(?:test|build)|xcodebuild)\b/i.test(
      segments[0] ?? "",
    )
  )
    return null;
  if (!segments.slice(1).every((segment) => /^(?:tail|head|grep|rg)\b/.test(segment))) return null;
  return JSON.stringify([record.cwd ?? "", cd?.[1] ?? ""]);
}

/** Dependency setup is idempotent within one turn. Local models sometimes replay a successful
 * install verbatim after a tool round; executing it again only mutates the lockfile timestamp and
 * burns context. Keep the key deliberately narrow so arbitrary successful shell commands are
 * never cached. */
export function repeatableSetupCommandKey(tool: string, args: unknown): string | null {
  if (tool !== "bash") return null;
  const command = (args as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return null;
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!/^(?:cd\s+[^;&|]+\s+&&\s+)?bun\s+(?:add|install)\b[^;&|]*$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

/** Keep a completion audit focused on checking the implementation that already exists. Runtime
 * evidence has a dedicated tool because ad-hoc background servers hide teardown and exit-status
 * failures. Likewise, once a relevant check already passes, creating another test file during the
 * audit is scope expansion rather than verification of the current edit. */
export function completionAuditToolBlock(
  tool: string,
  args: unknown,
  options: { isNewPath?: boolean; hasPassingVerification?: boolean } = {},
): string | null {
  const record = (args ?? {}) as Record<string, unknown>;
  if (tool === "bash") {
    const command = typeof record.command === "string" ? record.command : "";
    if (verificationCommandMasksExit(tool, args)) {
      return "Completion-audit verification must preserve the verifier's exit status. Run the verifier by itself, or capture its status and end with `exit $status`; do not append `echo EXIT=$?` or another command whose success can hide a failed check.";
    }
    if (verificationCommandKey(tool, args)) return null;
    const launchesRuntime =
      /\b(?:Bun\.serve|createServer\s*\(|(?:bun|node|python\d*)\s+(?:run\s+)?(?:dev|serve|server|start)\b)/i.test(
        command,
      );
    const probesLocalhost = /\b(?:curl|wget)\b[^\n]*(?:localhost|127\.0\.0\.1|\[::1\])/i.test(
      command,
    );
    if (launchesRuntime || probesLocalhost) {
      return "Completion-audit runtime probes must use smoke_run for launch evidence or render_check for render evidence — render_check launches your existing dev command and inspects the rendered localhost page without changing the project. Do not start a background server, add a helper server, or probe localhost through bash. Use one of those once, or qualify the runtime claim if it cannot be executed.";
    }
  }

  const path = typeof record.path === "string" ? record.path : "";
  const content = [record.content, record.new_text, record.patch]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (options.isNewPath && /\b(?:Bun\.serve|createServer\s*\(|\.listen\s*\()/i.test(content)) {
    return "The completion audit may not create an ad-hoc server or runtime harness. Use smoke_run against the existing application entry point, or render_check to launch it and inspect the rendered page, or report that runtime behavior remains unverified.";
  }
  if (options.isNewPath && options.hasPassingVerification && path && isTestPath(path)) {
    return "A relevant verification already passes. The completion audit may not create a new test file solely to manufacture additional evidence; inspect the existing behavior, use smoke_run for runtime claims, or report the remaining limitation.";
  }
  return null;
}

/** A failed smoke must not cause the implementation to install a disposable static-server
 * dependency into the user's project merely to produce evidence. bunx/existing project commands
 * remain available without mutating package.json or the lockfile. */
export function smokeInfrastructureInstallBlock(
  tool: string,
  args: unknown,
  smokeAttempted: boolean,
): string | null {
  if (!smokeAttempted || tool !== "bash") return null;
  const command = ((args ?? {}) as Record<string, unknown>).command;
  if (typeof command !== "string" || !/\bbun\s+add\b/i.test(command)) return null;
  if (
    !/(?:^|\s)(?:serve|http-server|live-server|static-server)(?:@[^\s]+)?(?=\s|$)/i.test(command)
  ) {
    return null;
  }
  return "Do not add a disposable static-server dependency solely for smoke verification. Use an existing project command or bunx without changing the manifest; otherwise report the launch limitation.";
}

/** Char cap on the always-re-injected originating user message — defends the budget against a
 *  pathologically large paste (~2000 tokens) while staying ample for real requests. */
const MAX_LIVE_USER_MESSAGE_CHARS = 8000;

/** Internal reminders are part of the model prompt, not user-authored transcript content. Keep
 * them in conversation history while removing them from the user_input event rendered by UIs. */
export function transcriptUserInput(input: string): string {
  return input
    .replace(/\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const APPROVED_SPEC_EXECUTION = /^Implement the approved spec at `([^`]+)`\.$/;
const APPROVED_SPEC_FALLBACK_STEPS = [
  "Read and confirm the approved specification",
  "Implement the approved requirements",
  "Add or update focused tests",
  "Run final verification",
] as const;

/** Convert a host-authored direct approved-spec handoff into a deterministic working list. The
 * original write_file payload is already durable session context, so no filesystem read or model
 * turn is needed. A compact generic list preserves tracker visibility when an older transcript
 * omitted tool arguments. */
export function approvedSpecExecutionStepTitles(userInput: string, history: Message[]): string[] {
  const document = approvedSpecExecutionDocument(userInput, history);
  if (document === null) return [];
  const steps = approvedPlanStepTitles(document);
  return steps.length > 0 ? steps : [...APPROVED_SPEC_FALLBACK_STEPS];
}

function approvedSpecExecutionDocument(userInput: string, history: Message[]): string | null {
  const match = userInput.trim().match(APPROVED_SPEC_EXECUTION);
  if (!match) return null;
  const specPath = match[1]!.replace(/^\.\//, "");
  for (let messageIndex = history.length - 1; messageIndex >= 0; messageIndex--) {
    const message = history[messageIndex]!;
    if (message.role !== "assistant") continue;
    for (const call of [...(message.toolCalls ?? [])].reverse()) {
      if (call.name !== "write_file") continue;
      const args = call.args as { path?: unknown; content?: unknown } | null;
      const path = typeof args?.path === "string" ? args.path.replace(/^\.\//, "") : "";
      if (path !== specPath || typeof args?.content !== "string") continue;
      return args.content;
    }
  }
  return "";
}

/** Key for per-(provider, model) runtime state: capability latches, provisional notices,
 *  last-observed windows. Same model id on two providers is two distinct pairs. */
function providerModelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** Minimal seam the runtime needs from the diagnostics layer. */
export interface DiagnosticsChecker {
  check(file: string, signal: AbortSignal): Promise<{ text: string } | null>;
  /** Coalesced per-step check: one run per distinct provider over the edited paths. */
  checkFiles(files: string[], signal: AbortSignal): Promise<{ text: string }[]>;
}

export interface AgentRuntimeOptions {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  dispatcher: ToolDispatcher;
  log: EventSink;
  router: Router;
  systemPrompt: () => string;
  /** Active project root. ACP supplies a per-turn accessor; terminal paths pass a fixed string. */
  projectDir: string | (() => string);
  resolvePermission: ResolvePermission;
  /** Per-turn tool-call cap. A plain number or an accessor (so `/maxloops` can change it live
   *  between turns). `Infinity` = unlimited. */
  maxToolLoops: number | (() => number);
  /** Current reasoning-effort level, read per turn. Defaults to "medium" when omitted. */
  effort?: () => EffortLevel;
  /** Whether out-of-project writes are currently permitted, read per tool call. Defaults
   *  to false when omitted. */
  allowOutsideProject?: () => boolean;
  /** When present, runs after each successful file-mutating tool to surface new diagnostics. */
  diagnostics?: DiagnosticsChecker;
  /** When present, reformats edited files (in place) before the diagnostics check. */
  formatter?: Formatter;
  /** When present, records pre-turn file state + the conversation anchor for /rewind. */
  checkpoints?: CheckpointRecorder;
  /** When present, the runtime persists/loads exact conversation snapshots for resume/fork. */
  historyStore?: SessionHistoryStore;
  /** When it returns true, mutating tools are blocked (plan mode) — denied with a steering message. */
  planMode?: () => boolean;
  /** Context-window settings, read per turn. Defaults to DEFAULT_CONTEXT when omitted. */
  context?: () => ContextConfig;
  /** Loop-guard settings accessor. Omit to disable the guard entirely. */
  loopGuard?: () => LoopGuardConfig;
  /** Per-worker-turn token-spend ceiling. Enforced only for `source === "orchestration-worker"`.
   *  0/undefined = unlimited. Sourced from `orchestration.worker_turn_tokens`. */
  workerTurnTokens?: number;
  workerProgressExtensionTokens?: number;
  workerMaxTokenMultiplier?: number;
  /** For machine-protocol workers, reserve the last fraction of the budget for a required final
   *  response by disabling further tools once this fraction is reached. */
  workerConvergenceFraction?: number;
  /** Per-worker-turn early-stop: stop when this many tokens accrue since the last landed edit
   *  (0/undefined = disabled). Sourced from `orchestration.worker_no_progress_tokens`. */
  workerNoProgressTokens?: number;
  /** Whether this orchestration worker is expected to edit files. General workers set this true;
   *  read-only explore workers set it false so they are never punished for doing their job. */
  workerRequiresEdit?: boolean;
  /** Per-worker-turn wall-clock ceiling (ms); 0/undefined = unlimited. Orchestration workers
   *  only. Sourced from `orchestration.worker_turn_ms`. Enforced in Task 5. */
  workerTurnMs?: number;
  /** Worker-turn thrash ceiling: consecutive failing runs of one command that abort the turn.
   *  Consulted ONLY for source "orchestration-worker". Absent/0 → no thrash abort. */
  workerThrashRepeats?: () => number;
  /** Worker-only recreate guard: when it returns true, a `write_file` over a file that exists on
   *  disk but is untouched by this worker this turn is refused. Consulted ONLY for
   *  source "orchestration-worker". Absent → false (guard off). Sourced from
   *  `orchestration.protect_existing_files`. */
  protectExistingFiles?: () => boolean;
  /** Worker-only pending-scope guard: when it returns true, a `write_file` creating a BRAND-NEW
   *  file whose path matches a still-pending task's title is refused. Consulted ONLY for
   *  source "orchestration-worker". Absent → false. Sourced from `orchestration.guard_pending_scope`. */
  guardPendingScope?: () => boolean;
  /** Still-pending task titles for THIS worker turn (set per-spawn by the orchestration worker
   *  spawner). Consulted by the pending-scope guard. Absent → []. */
  pendingTaskTitles?: () => string[];
  /** Explicit paths named by this focused orchestration task. When non-empty, package/build
   * infrastructure outside this set is protected from both structured edits and package-manager
   * bash commands. */
  workerOwnedPaths?: () => string[];
  /** Plan-mode guard settings accessor. When provided, forces a plan-synthesis pass after
   *  forcePlanAfterBlocks consecutive blocked mutating-tool attempts. */
  planModeGuard?: () => PlanModeGuardConfig;
  /** Runaway-stream watchdog settings accessor. Defaults to DEFAULT_STREAM_WATCHDOG when omitted. */
  streamWatchdog?: () => StreamWatchdogConfig;
  /** Malformed-path detector settings accessor. Omit to disable. */
  malformedPath?: () => MalformedPathConfig;
  /** Served context window lookup. Called with no arguments for the ACTIVE pair (budget on
   *  legacy paths, compaction, low-context warning); the capability latch and per-call budget
   *  pass the PREVIEWED/ROUTED model and provider so the evidence names the pair actually
   *  being called. */
  modelContextLength?: (model?: string, provider?: string) => number | undefined;
  /** Served context window WITH its source for the capability latch. `loaded` (authoritative)
   *  latches permanently; `architectural` (Ollama /api/show ceiling) grants the surface
   *  provisionally so a later loaded window can still downgrade. Omit → the latch falls back to
   *  `modelContextLength`, treating any known window as authoritative (back-compat). */
  modelContextInfo?: (model?: string, provider?: string) => WindowInfo | undefined;
  /** Family-adapter settings (from config.modelFamily); threaded into each chat request. */
  modelFamily?: ModelFamilyConfig;
  /** Constrained-decoding mode for corrective retries (WS4), read per retry. Defaults to
   *  "auto" when omitted; "off" disables the tool-call envelope entirely. */
  structuredOutput?: () => "auto" | "off";
  /** Capability-surface mode (WS5), read per turn: explicit "small"/"standard", or "auto"
   *  (per-model latch from the served window). Omit → "standard" (full surface, back-compat). */
  capability?: () => CapabilityMode;
  modelProfile?: (model: string, provider: string) => ModelProfile | undefined;
  /** System prompt served at small capability (distilled persona + halved repo map). Omit →
   *  `systemPrompt` is used at every capability. */
  smallSystemPrompt?: () => string;
  /** Short hidden reminder appended to the live user turn so the selected personality remains
   * visible even for local models that underweight a long system-prompt overlay. Empty = none. */
  voiceReminder?: () => string;
  /** Optional bounded final-prose compliance check. Returns a minimal copy-edit pass only when
   * the active personality is missing from substantive prose; null keeps the original answer. */
  voiceCorrection?: (text: string) => {
    systemPrompt: string;
    instruction: string;
    accept?: (candidate: string) => boolean;
  } | null;
  /** User PreToolUse/PostToolUse hooks. Undefined → no hook interposition (current behavior). */
  hooks?: HookEngine;
  /** Whether web tools are currently enabled; gates the version-pin docs reminder.
   *  Omit → treated as enabled. */
  webToolsEnabled?: () => boolean;
  /** Run one bounded requirement/test/evidence audit after a user-facing direct turn edits
   *  implementation files. Explicit opt-in keeps evaluators and isolated workers single-pass. */
  completionAudit?: boolean;
  /** Hard audit budgets, including blocked/cached attempts. Independent of the main turn cap. */
  completionAuditLimits?: { modelCalls: number; toolAttempts: number };
  /** Returns ready-to-append `<system-reminder>` blocks for skills that auto-trigger on this
   *  turn's user input. Empty when auto-invocation is gated off or nothing matches. Wired in
   *  bin/cleetus.ts (and acp/runtime.ts) so the runtime stays free of registry/config knowledge. */
  triggeredSkillReminders?: (
    userInput: string,
  ) => Array<string | { name: string; reminder: string }>;
  /** Emit a restrained `/learn` suggestion after an interactive turn recovers from repeated
   *  executed-tool failures or empty structured retrievals. Intended for the TUI; workers and
   *  sourced turns are excluded. */
  suggestLearnedPlaybook?: boolean;
}

/** Per-session trim state: the FROZEN boundary index (history before it is summarized into
 *  the digest and never re-sent), the rolling digest, and a one-shot large-context warning flag.
 *  Freezing the boundary keeps the model-call prompt prefix byte-stable between trim events,
 *  which is what restores KV-cache reuse on the server. */
interface TrimState {
  boundaryIndex: number;
  digest: DigestState;
  warned: boolean;
  /** Last observed context length PER provider:model pair, for the one-shot budget-upgrade
   *  notice. Key absent = never observed (the old "unset"); a key may map to undefined
   *  (observed-as-unknown). Single-valued state here would flip-flop under smart routing and
   *  re-fire the notice on every small→large alternation. */
  lastContextLengthByModel: Map<string, number | undefined>;
  /** SESSION-MINIMUM live tool-result cap (chars) across every assembleMessages run —
   *  monotone non-increasing; consumed by the read-cache elision predicate so a body that
   *  ANY routed pair's assembly could have truncated is never treated as verbatim. */
  liveCap?: number;
}

export class AgentRuntime {
  private readonly auditCallGates = new Map<string, () => string | null>();
  private historyBySession: Map<string, Message[]> = new Map();
  private warnedServed: Set<string> = new Set();
  private latestTodosBySession: Map<string, TodoItem[]> = new Map();
  private todoContractBySession: Map<string, SeededTodoContract> = new Map();
  private remindedPinsBySession: Map<string, Set<string>> = new Map();
  /** Sticky skill reminders accumulated while a plan is drafted; replayed after plan mode exits
   *  so a plan-triggered skill (e.g. TDD) reaches the approval + implementation turns (arc). */
  private arcSkillsBySession: Map<string, string[]> = new Map();
  /** Previous turn's plan-mode value per session, to detect plan-mode entry (arc reset). */
  private wasPlanModeBySession: Map<string, boolean> = new Map();
  private trimBySession = new Map<string, TrimState>();
  private loopGuardBySession = new Map<string, LoopGuard>();
  private readCacheBySession = new Map<string, SessionReadCache>();
  /** Absolute paths this worker turn has read or written — a write_file over a path NOT in this
   *  set (but present on disk) is a recreate of a prior task's file. Per-session; workers get a
   *  fresh runtime, so "this session" == "this worker turn". */
  private touchedPathsBySession = new Map<string, Set<string>>();
  /** Model ids that 400'd with "does not support thinking" this session — applyEffort omits
   *  reasoning_effort for them so we don't repeat the failed call. */
  private readonly noThinkModels = new Set<string>();
  /** Provider/model/output-budget combinations whose bounded finish pass has already hit its
   * ceiling. Keep the budget in the key: a failed 1K personality edit must not disable a later
   * 4K synthesis pass for the same model. */
  private readonly finishPassLengthFailures = new Set<string>();
  private readonly finishPassSuppressionNotices = new Set<string>();
  /** Per provider:model pair capability latched ONLY once an authoritative (`loaded`, e.g.
   *  Ollama `/api/ps`) context window is actually known (auto mode only). Never flips once set:
   *  late window detection upgrades the budget, not the surface (WS5), and a pair already
   *  latched to "small" on real evidence never reconsiders. An `architectural` window (e.g.
   *  `/api/show`) never reaches this latch — it grants "standard" only provisionally. */
  private readonly capabilityByProviderModel = new Map<string, Capability>();
  /** Provider:model pairs currently serving a provisional (un-latched) "small" surface because
   *  no authoritative (`loaded`) window is known yet. Doubles as the once-per-pair guard for the
   *  "window unknown" notice AND the signal that a later authoritative-window latch to "standard"
   *  should announce an upgrade. */
  private readonly provisionalSmallKeys = new Set<string>();
  /** Provider:model pairs that have already emitted the one-time "standard surface detected"
   *  upgrade notice. Needed because an architectural window grants standard WITHOUT latching, so
   *  without this guard the notice would re-fire every turn. */
  private readonly standardAnnounced = new Set<string>();
  /** Provider names whose server 4xx'd on `response_format` — constrained decoding is never
   *  sent to them again this session (attempt-and-memoize, WS4; mirrors noThinkModels). */
  private readonly noResponseFormat = new NoResponseFormatMemo();
  /** Sessions whose trim boundary advanced since their last user turn — the next turn gets a
   *  one-shot todo-list reminder so the plan survives compaction (WS6.1). */
  private todoReinjectBySession = new Set<string>();

  /** Lazily create the session's read cache (annotates unchanged re-reads, #143). */
  private readCacheForSession(sessionId: string): SessionReadCache {
    let c = this.readCacheBySession.get(sessionId);
    if (!c) {
      c = new SessionReadCache();
      this.readCacheBySession.set(sessionId, c);
    }
    return c;
  }

  private touchedPathsForSession(sessionId: string): Set<string> {
    let s = this.touchedPathsBySession.get(sessionId);
    if (!s) {
      s = new Set<string>();
      this.touchedPathsBySession.set(sessionId, s);
    }
    return s;
  }

  constructor(private readonly opts: AgentRuntimeOptions) {}

  private get currentEffort(): EffortLevel {
    return this.opts.effort?.() ?? DEFAULT_EFFORT;
  }

  /** Normalizes `maxToolLoops` from either a plain number or a live accessor. */
  private maxLoops(): number {
    const v = this.opts.maxToolLoops;
    return typeof v === "function" ? v() : v;
  }

  /** Current session working list for UI hydration. Returns a copy so render state cannot mutate
   *  the runtime's model-facing list. Completed lists are retained here for context; consumers
   *  decide whether an already-finished list should still be displayed. */
  getSessionTodos(sessionId: string): TodoItem[] {
    return (this.latestTodosBySession.get(sessionId) ?? []).map((todo) => ({ ...todo }));
  }

  resetHistory(sessionId: string): void {
    this.historyBySession.delete(sessionId);
    this.warnedServed.delete(sessionId);
    this.latestTodosBySession.delete(sessionId);
    this.todoContractBySession.delete(sessionId);
    this.todoReinjectBySession.delete(sessionId);
    this.remindedPinsBySession.delete(sessionId);
    this.arcSkillsBySession.delete(sessionId);
    this.wasPlanModeBySession.delete(sessionId);
    this.trimBySession.delete(sessionId);
    this.loopGuardBySession.delete(sessionId);
    this.readCacheBySession.delete(sessionId);
    this.touchedPathsBySession.delete(sessionId);
  }

  /** Truncate the model-facing history of a session to `length` messages. Used by
   *  /rewind to revert the conversation alongside the on-disk files. No-op when the
   *  length is out of range. Only the message history is trimmed; callers that need
   *  the working todo list reset are responsible for that separately. */
  truncateHistory(sessionId: string, length: number): void {
    const h = this.historyBySession.get(sessionId);
    if (h && length >= 0 && length < h.length) h.length = length;
    this.trimBySession.delete(sessionId);
    this.loopGuardBySession.delete(sessionId);
    this.readCacheBySession.delete(sessionId);
    this.touchedPathsBySession.delete(sessionId);
    // Re-allow the version-pin reminder after a rewind: re-running a pinned request should
    // re-ground the model on the retry.
    this.remindedPinsBySession.delete(sessionId);
  }

  /**
   * Seed a restored todo list into a session: pushes a synthetic `todo_write`
   * exchange into the in-memory history (so the model sees the list as its own
   * prior action) and emits the matching tool_call_start/end events (so the TUI
   * renders the checklist block). Used by the startup restore prompt.
   */
  seedTodoList(sessionId: string, todos: TodoItem[]): void {
    const history = this.getHistory(sessionId);
    const callId = ulid();
    const call = { id: callId, name: "todo_write", args: { todos } };
    const output = renderTodoLines(todos);
    history.push({ role: "assistant", content: "", toolCalls: [call] });
    history.push({ role: "tool", toolCallId: callId, content: output });
    this.opts.log.append({ sessionId, type: "tool_call_start", payload: { call } });
    this.opts.log.append({
      sessionId,
      type: "tool_call_end",
      payload: { call, ok: true, output, todos },
    });
    this.latestTodosBySession.set(sessionId, todos);
  }

  /** Push a synthetic assistant message into a session's in-memory history AND emit an
   *  assistant_message event — so an out-of-band process (review findings, orchestration outcome)
   *  becomes prior context the model can act on, and the TUI renders it like the model's output. */
  private pushAssistantHistory(sessionId: string, text: string): void {
    this.getHistory(sessionId).push({ role: "assistant", content: text });
    this.opts.log.append({ sessionId, type: "assistant_message", payload: { text } });
  }

  /** Inject a `/review` findings block into a session: pushes a synthetic assistant message into
   *  the in-memory history (so the model sees the findings as prior context and can act on a cited
   *  id, e.g. "fix R2") and emits an assistant_message event (so the TUI renders it plan-style,
   *  like the model's own output). Mirrors seedTodoList. */
  seedReviewFindings(sessionId: string, markdown: string): void {
    this.pushAssistantHistory(sessionId, markdown);
  }

  /** Append the orchestration outcome summary to the MAIN conversation so the model knows the build
   *  happened. Workers are context-isolated, so without this the main model reassembles history
   *  ending at the handoff and concludes nothing was built. Mirrors seedReviewFindings. */
  recordOrchestrationSummary(sessionId: string, text: string): void {
    this.pushAssistantHistory(sessionId, text);
  }

  /** Reset the working todo list to a rewind target's pre-turn snapshot. Unlike
   *  seedTodoList this pushes no history and emits no events — /rewind already
   *  truncated history to the pre-turn point, so the model sees the right list.
   *  An empty-array snapshot is treated identically to `undefined` (no todos).
   *  Returns `{ cleared: true }` only when a non-empty list was discarded (the
   *  rewind target had no todos), so the UI can say so. */
  restoreTodos(sessionId: string, todos?: TodoItem[]): { cleared: boolean } {
    const hadTodos = (this.latestTodosBySession.get(sessionId)?.length ?? 0) > 0;
    if (todos && todos.length > 0) {
      this.latestTodosBySession.set(sessionId, todos);
      return { cleared: false };
    }
    this.latestTodosBySession.delete(sessionId);
    return { cleared: hadTodos };
  }

  /** Persist the session's exact in-memory history + working todos. Advisory: a store
   *  failure is swallowed and never breaks a turn. No-op without a historyStore. */
  snapshotSession(sessionId: string): void {
    if (!this.opts.historyStore) return;
    try {
      const messages = this.historyBySession.get(sessionId) ?? [];
      const todos = this.latestTodosBySession.get(sessionId) ?? [];
      // SessionHistoryStore.save serializes synchronously, so passing the live arrays is safe.
      this.opts.historyStore.save(sessionId, messages, todos);
    } catch {
      // snapshot is advisory; never break the caller
    }
  }

  /** Seed a session's in-memory history + working todos from a snapshot (resume/fork).
   *  Replaces any existing in-memory state for that id. */
  loadSession(sessionId: string, messages: Message[], todos: TodoItem[]): void {
    this.historyBySession.set(sessionId, [...messages]);
    // Copy todos too (not just messages): two sessions forked from the same snapshot
    // must not share one array.
    if (todos.length > 0) this.latestTodosBySession.set(sessionId, [...todos]);
    else this.latestTodosBySession.delete(sessionId);
    const priorPlan = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" && approvedPlanStepTitles(message.content).length > 1,
      );
    if (priorPlan) this.todoContractBySession.set(sessionId, seededTodoContract(priorPlan.content));
    else this.todoContractBySession.delete(sessionId);
    // Match resetHistory: a replaced conversation should let the served-model notice fire again.
    this.warnedServed.delete(sessionId);
    this.trimBySession.delete(sessionId);
    this.loopGuardBySession.delete(sessionId);
    this.readCacheBySession.delete(sessionId);
    this.touchedPathsBySession.delete(sessionId);
    this.remindedPinsBySession.delete(sessionId);
  }

  /** Read-only snapshot of a session's current in-memory messages. Returns a copy
   *  (callers must not mutate runtime state) and `[]` for an unknown session. */
  getMessages(sessionId: string): Message[] {
    return [...(this.historyBySession.get(sessionId) ?? [])];
  }

  private getHistory(sessionId: string): Message[] {
    let h = this.historyBySession.get(sessionId);
    if (!h) {
      h = [];
      this.historyBySession.set(sessionId, h);
    }
    return h;
  }

  /** Default per-session trim state: no frozen boundary, empty digest, warning un-armed. */
  private emptyTrimState(): TrimState {
    return {
      boundaryIndex: 0,
      digest: { text: "", coveredThroughIndex: 0 },
      warned: false,
      lastContextLengthByModel: new Map(),
    };
  }

  /** Cap the always-kept originating user message so a huge paste can't itself overflow the
   *  budget. Returns the message unchanged when within the limit. Pure. */
  private capLiveUserMessage(m: Message): Message {
    if (m.content.length <= MAX_LIVE_USER_MESSAGE_CHARS) return m;
    const removed = m.content.length - MAX_LIVE_USER_MESSAGE_CHARS;
    return {
      ...m,
      content: `${m.content.slice(0, MAX_LIVE_USER_MESSAGE_CHARS)}\n… [truncated ${removed} chars of the original request to fit the window]`,
    };
  }

  /** Build the messages to send: [system, digest?, recent tail], using WATERMARK (hysteresis)
   *  trimming with a PERSISTED, FROZEN per-session boundary. The boundary only ever advances
   *  when the live tail crosses the high-water mark; until then the prompt prefix is
   *  byte-stable between turns, which is what restores server-side KV-cache reuse. Summarizing
   *  the newly-frozen prefix into the digest is advisory — it never throws to the turn loop. */
  private async assembleMessages(
    sessionId: string,
    history: Message[],
    systemPrompt: string,
    provider: Provider,
    model: string,
    providerName: string,
    abortSignal: AbortSignal,
    /** Estimated tokens of the tool schemas this call will carry (0 = tool-less call). */
    toolSchemaTokens = 0,
  ): Promise<Message[]> {
    const configured = this.opts.context?.() ?? DEFAULT_CONTEXT;
    const profile = this.opts.modelProfile?.(model, providerName);
    const cfg = {
      ...configured,
      maxBudgetTokens: profile?.max_budget_tokens ?? configured.maxBudgetTokens,
    };
    const state = this.trimBySession.get(sessionId) ?? this.emptyTrimState();

    const liveStart = liveTurnStart(history);
    const originating = history[liveStart];
    const keptUser =
      originating && originating.role === "user" ? this.capLiveUserMessage(originating) : null;

    const pairKey = providerModelKey(providerName, model);
    const contextLength = normalizeContextLength(
      this.opts.modelContextLength?.(model, providerName),
    );
    if (state.lastContextLengthByModel.has(pairKey)) {
      const upgrade = budgetUpgradeNotice(
        model,
        state.lastContextLengthByModel.get(pairKey),
        contextLength,
        {
          configBudgetTokens: cfg.budgetTokens,
          maxBudgetTokens: cfg.maxBudgetTokens,
        },
      );
      if (upgrade) {
        this.opts.log.append({
          sessionId,
          type: "notice",
          payload: { text: upgrade, level: "info" },
        });
      }
    }
    // Persisted by the trimBySession.set(...) at the end of this method; an early return
    // between here and there would silently re-fire the one-shot notice every call.
    state.lastContextLengthByModel.set(pairKey, contextLength);
    const budget = computeBudget({
      contextLength,
      configBudgetTokens: cfg.budgetTokens,
      maxBudgetTokens: cfg.maxBudgetTokens,
      responseReserveTokens: cfg.responseReserveTokens,
      systemPromptTokens: estimateTokens(systemPrompt),
      digestTokens: estimateTokens(state.digest.text),
      toolSchemaTokens,
      liveUserMessageTokens: keptUser ? messageTokens(keptUser) : 0,
    });

    // Defensive: a misconfigured or cross-file-merged config could leave low >= high, which
    // would make every turn trim (churn). Clamp the low-water target safely below high-water.
    const highFrac = cfg.trimHighWater;
    const lowFrac = Math.min(cfg.trimLowWater, highFrac * 0.95);

    const tailTokens = sumTokens(history, state.boundaryIndex, history.length);
    // `budget` already excludes the system prompt, digest, response reserve, and the kept user
    // message (see computeBudget), so it is the allowance for the history tail alone. Trim
    // whenever the tail exceeds high-water. The tail now spans the live turn too, so a long
    // single turn (many tool round-trips with no new user message) is foldable.
    const high = budget * highFrac;
    if (tailTokens > high) {
      const newBoundary = protectFreshestToolResult(
        history,
        computeRecentBoundary(history, budget * lowFrac),
      );
      if (newBoundary > state.boundaryIndex) {
        const slice = history.slice(state.digest.coveredThroughIndex, newBoundary);
        if (cfg.summarize) {
          this.opts.log.append({
            sessionId,
            type: "compaction_start",
            payload: { messageCount: slice.length, reason: "auto" },
          });
          const t0 = Date.now();
          const {
            state: digest,
            ok,
            partial,
          } = await compact(
            state.digest,
            slice,
            newBoundary,
            (oldText, s, instruction, timeoutMs) =>
              this.summarizeSlice(
                provider,
                model,
                oldText,
                s,
                abortSignal,
                instruction,
                timeoutMs ?? cfg.summaryTimeoutMs,
              ),
            {
              maxSummaryInputTokens: cfg.maxSummaryInputTokens,
              maxElapsedMs: cfg.summaryTimeoutMs,
            },
          );
          state.digest = digest;
          this.opts.log.append({
            sessionId,
            type: "compaction_end",
            payload: {
              messageCount: slice.length,
              elapsedMs: Date.now() - t0,
              outcome: ok ? "summarized" : partial ? "partial" : "dropped",
            },
          });
          this.emitTrimNotice(
            sessionId,
            slice.length,
            ok ? "summarized" : partial ? "partial" : "dropped",
          );
        } else {
          state.digest = { text: "", coveredThroughIndex: newBoundary };
          this.emitTrimNotice(sessionId, slice.length, "dropped");
        }
        state.boundaryIndex = newBoundary;
        state.warned = false;
        this.todoReinjectBySession.add(sessionId);
      }
    }

    this.trimBySession.set(sessionId, state);

    const digestMessage = buildDigestMessage(state.digest.text);
    // Scale the live cap to the actual tail budget so one fresh result can never exceed the
    // whole allowance at a small window (WS1.2). tokens→chars via the same 4:1 estimate;
    // config value remains the ceiling at large windows. Floor of 1000 chars keeps a minimal
    // useful result even at MIN_BUDGET.
    const liveCap = Math.max(
      1000,
      Math.min(cfg.maxLiveToolResultChars, Math.floor(budget * 0.4) * 4),
    );
    // The elision guard must be conservative ACROSS routed pairs: a body elided under a
    // large pair's cap can be head/tail-cut by a later small-pair assembly, so reconcile
    // against the smallest cap this session has ever assembled with. Monotone non-increasing;
    // the cost of a stale small minimum is only a re-send (safe direction).
    state.liveCap = Math.min(liveCap, state.liveCap ?? Number.POSITIVE_INFINITY);
    const tail = slimDeepHistory(
      history.slice(state.boundaryIndex),
      liveStart,
      state.boundaryIndex,
      cfg.maxDeepToolResultChars,
      liveCap,
    );
    // Re-inject the originating user message verbatim when the boundary folded past it, so the
    // task itself is never summarized away. When the boundary is still at/before liveStart the
    // message is already in `tail`, so do NOT duplicate it.
    const reinjected = keptUser && state.boundaryIndex > liveStart ? [keptUser] : [];
    let assembled = [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      ...(digestMessage ? [digestMessage] : []),
      ...reinjected,
      ...tail,
    ];

    const safeInputLimit = safeAssembledInputLimit(contextLength);
    if (
      safeInputLimit !== undefined &&
      sumTokens(assembled, 0, assembled.length) + toolSchemaTokens > safeInputLimit
    ) {
      const system = systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : [];
      const fixedTokens = sumTokens(system, 0, system.length) + toolSchemaTokens;
      const recentBudget = Math.max(128, safeInputLimit - fixedTokens);
      const recentBoundary = protectFreshestToolResult(
        tail,
        computeRecentBoundary(tail, recentBudget),
      );
      const recent = tail.slice(recentBoundary).filter((message) => message !== originating);
      assembled = [...system, ...(keptUser ? [keptUser] : []), ...recent];
      const fittedTokens = sumTokens(assembled, 0, assembled.length) + toolSchemaTokens;
      this.opts.log.append({
        sessionId,
        type: "notice",
        payload: {
          text: `context hard trim: reduced the assembled request to ~${fittedTokens} estimated tokens for a ${contextLength}-token served window`,
          level: "warn",
          kind: "context_hard_trim",
        },
      });
      if (fittedTokens > safeInputLimit) {
        throw new CleetusError(
          "PROVIDER_INVALID_RESPONSE",
          `assembled request is still ~${fittedTokens} estimated tokens after trimming, above the safe ${safeInputLimit}-token input limit for the served ${contextLength}-token window; increase the model context or reduce the active tool/capability surface`,
        );
      }
    }

    this.maybeWarnInputSize(sessionId, state, assembled, cfg, contextLength);
    return assembled;
  }

  /** Vision-capability verdict for the model that would serve the next turn, plus that model's
   *  name (for gate messages). Resolves the active provider/model the same way the turn loop does
   *  (context-free, matching how the TUI/CLI probe before a turn), then queries the provider's
   *  optional `supportsVision`; an omitted probe is treated as "unknown". */
  async visionSupportForActiveModel(
    messages: Message[] = [],
  ): Promise<{ support: VisionSupport; model: string }> {
    const choice = this.opts.router.select({ turnIndex: 0, messages }).choice;
    const support =
      (await this.opts.providers.get(choice.provider).supportsVision?.(choice.model)) ?? "unknown";
    return { support, model: choice.model };
  }

  /** Force a compaction now: fold the session's trimmable history (everything before the
   *  live turn) into the digest via the resilient compact path, freeze the new boundary, and
   *  return the token delta. `instruction` biases the summary. No-op when already minimal
   *  (the live turn is the whole trimmable region). Used by the `/compact` command. */
  async compactNow(
    sessionId: string,
    instruction?: string,
  ): Promise<{
    compacted: boolean;
    messagesFolded: number;
    beforeTokens: number;
    afterTokens: number;
    partial: boolean;
  }> {
    const history = this.getHistory(sessionId);
    const cfg = this.opts.context?.() ?? DEFAULT_CONTEXT;
    const state = this.trimBySession.get(sessionId) ?? this.emptyTrimState();
    const before =
      sumTokens(history, state.boundaryIndex, history.length) + estimateTokens(state.digest.text);

    // Keep a recent verbatim reserve; fold everything older (including completed round-trips of
    // the current live turn). Mirrors assembleMessages' low-water target without needing the
    // system prompt: derive the reserve from the model window (or configured budget).
    const reserve = Math.floor(
      budgetBase({
        contextLength: this.opts.modelContextLength?.(),
        configBudgetTokens: cfg.budgetTokens,
        maxBudgetTokens: cfg.maxBudgetTokens,
      }) * cfg.trimLowWater,
    );
    const newBoundary = protectFreshestToolResult(history, computeRecentBoundary(history, reserve));
    if (newBoundary <= state.boundaryIndex) {
      return {
        compacted: false,
        messagesFolded: 0,
        beforeTokens: before,
        afterTokens: before,
        partial: false,
      };
    }

    // Resolve the active provider/model the same way the turn loop does.
    const choice = this.opts.router.select({ turnIndex: 0, messages: history }).choice;
    const provider = this.opts.providers.get(choice.provider);
    const model = choice.model;

    const slice = history.slice(state.digest.coveredThroughIndex, newBoundary);
    let partial = false;
    if (cfg.summarize) {
      this.opts.log.append({
        sessionId,
        type: "compaction_start",
        payload: { messageCount: slice.length, reason: "manual" },
      });
      const t0 = Date.now();
      const {
        state: digest,
        ok,
        partial: p,
      } = await compact(
        state.digest,
        slice,
        newBoundary,
        (oldText, s, instr, timeoutMs) =>
          this.summarizeSlice(
            provider,
            model,
            oldText,
            s,
            new AbortController().signal,
            instr,
            timeoutMs ?? cfg.summaryTimeoutMs,
          ),
        {
          maxSummaryInputTokens: cfg.maxSummaryInputTokens,
          instruction,
          maxElapsedMs: cfg.summaryTimeoutMs,
        },
      );
      state.digest = digest;
      partial = p;
      this.opts.log.append({
        sessionId,
        type: "compaction_end",
        payload: {
          messageCount: slice.length,
          elapsedMs: Date.now() - t0,
          outcome: ok ? "summarized" : p ? "partial" : "dropped",
        },
      });
      this.emitTrimNotice(sessionId, slice.length, p ? "partial" : "summarized");
    } else {
      state.digest = { text: "", coveredThroughIndex: newBoundary };
      this.emitTrimNotice(sessionId, slice.length, "dropped");
    }
    state.boundaryIndex = newBoundary;
    state.warned = false;
    this.todoReinjectBySession.add(sessionId);
    this.trimBySession.set(sessionId, state);

    const after =
      sumTokens(history, state.boundaryIndex, history.length) + estimateTokens(state.digest.text);
    return {
      compacted: true,
      messagesFolded: slice.length,
      beforeTokens: before,
      afterTokens: after,
      partial,
    };
  }

  /** One-shot large-context warning. Fires once per session; reset after a trim. */
  private maybeWarnInputSize(
    sessionId: string,
    state: TrimState,
    assembled: Message[],
    cfg: ContextConfig,
    ctxLen: number | undefined,
  ): void {
    if (state.warned) return;
    const threshold = cfg.warnTokens ?? (ctxLen ? Math.floor(ctxLen * 0.7) : 50000);
    const total = sumTokens(assembled, 0, assembled.length);
    if (total < threshold) return;
    state.warned = true;
    const k = Math.round(total / 1000);
    this.opts.log.append({
      sessionId,
      type: "notice",
      payload: {
        text: `Large context (~${k}k tokens) — model calls will be slow. Run /compact to summarize and free space.`,
        level: "warn",
      },
    });
  }

  /** One-shot summarization call against the active model, folding `priorDigestText` and
   *  `slice` into an updated digest. Returns the digest text (or "" on empty/finish).
   *  Errors propagate to compact's per-chunk handling. Intentionally emits NO
   *  model_call_start/end events — this is advisory infrastructure and would otherwise
   *  pollute the turn history. */
  private async summarizeSlice(
    provider: Provider,
    model: string,
    priorDigestText: string,
    slice: Message[],
    abortSignal: AbortSignal,
    instruction: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const messages: Message[] = [
      { role: "system", content: DIGEST_SYSTEM_PROMPT },
      { role: "user", content: renderSliceForSummary(priorDigestText, slice, instruction) },
    ];
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    // A listener added to an already-aborted signal never fires, so link eagerly: if the turn
    // was cancelled before we got here, abort now rather than waiting out the full timeout.
    if (abortSignal.aborted) ctrl.abort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      let buf = "";
      for await (const ev of provider.chat({
        model,
        messages,
        signal: ctrl.signal,
        modelFamily: this.opts.modelFamily,
      })) {
        if (ev.type === "text-delta") buf += ev.text;
      }
      return buf;
    } catch (e) {
      if (timedOut) throw new SummaryTimeoutError(timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", onAbort);
    }
  }

  private emitTrimNotice(
    sessionId: string,
    count: number,
    kind: "summarized" | "partial" | "dropped",
  ): void {
    const n = `${count} earlier message${count === 1 ? "" : "s"}`;
    const text =
      kind === "summarized"
        ? `Context trimmed: summarized ${n} to fit the window.`
        : kind === "partial"
          ? `Context trimmed: compacted ${n} (partial summary — summarizer degraded).`
          : `Context trimmed: dropped ${n}.`;
    this.opts.log.append({ sessionId, type: "notice", payload: { text, level: "warn" } });
  }

  private buildToolSchemas(
    capability: Capability = "standard",
    taskTools: ReadonlySet<string> = new Set(),
  ): ToolSchema[] {
    return filterToolsForCapability(this.opts.tools.all(), capability, taskTools).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /** The envelope for a constrained corrective retry, or undefined when constrained decoding
   *  is off or this provider is memoized as unsupporting. */
  private retryEnvelope(providerName: string, toolSchemas: ToolSchema[]) {
    if ((this.opts.structuredOutput?.() ?? "auto") === "off") return undefined;
    if (this.noResponseFormat.has(providerName)) return undefined;
    return toolCallEnvelope(toolSchemas.map((t) => t.name));
  }

  /** Run one streaming model call: logs model_call_start on entry, text chunks, and a
   * hidden reasoning event. Logs model_call_end (with the served model) on a clean finish
   * event; if the stream closes without one, model_call_end is not emitted. Returns the
   * accumulated result. Exceptions propagate to the caller. */
  private async streamCall(p: {
    sessionId: string;
    provider: Provider;
    model: string;
    messages: Message[];
    toolSchemas: ToolSchema[];
    abortSignal: AbortSignal;
    tier: RouteDecision["tier"];
    reason: string;
    /** Optional per-call generation ceiling. Normal work is uncapped; bounded finish and
     * corrective passes set this so a copy edit cannot turn into another full reasoning run. */
    maxOutputTokens?: number;
    /** Per-call effort override used by bounded corrective passes. */
    effortOverride?: EffortLevel;
    /** Constrained-decoding envelope for a corrective retry (WS4); absent for a normal call. */
    responseFormat?: ChatOptions["responseFormat"];
  }): Promise<{
    textBuf: string;
    reasoningBuf: string;
    toolCalls: { id: string; name: string; args: unknown }[];
    finishReason: "stop" | "tool-calls" | "length" | "error";
    servedModel?: string;
    anyRecovered: boolean;
    usage: { input: number; output: number };
  }> {
    const auditStop = this.auditCallGates.get(p.sessionId)?.();
    if (auditStop)
      return {
        textBuf: auditStop,
        reasoningBuf: "",
        toolCalls: [],
        finishReason: "stop",
        anyRecovered: false,
        usage: { input: 0, output: 0 },
      };
    const { log } = this.opts;
    const callId = ulid();
    log.append({
      sessionId: p.sessionId,
      type: "model_call_start",
      payload: { callId, model: p.model, tier: p.tier, reason: p.reason },
    });
    let textBuf = "";
    let reasoningBuf = "";
    const toolCalls: { id: string; name: string; args: unknown }[] = [];
    let finishReason: "stop" | "tool-calls" | "length" | "error" = "stop";
    let servedModel: string | undefined;
    let anyRecovered = false;
    const usage = { input: 0, output: 0 };
    const wd = this.opts.streamWatchdog?.() ?? DEFAULT_STREAM_WATCHDOG;
    const watchdog = new AbortController();
    const signal = wd.enabled ? AbortSignal.any([p.abortSignal, watchdog.signal]) : p.abortSignal;
    // Two timers feed one abort. `wdKind`/`wdLimitMs` capture which fired for the notice.
    // Idle resets on every stream event (incl. tool-call-delta heartbeats); the ceiling is
    // armed once and never reset, backstopping a continuously-streaming runaway loop.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
    let wdKind:
      | "idle"
      | "ceiling"
      | "first_token"
      | "repetition"
      | "rumination"
      | "reasoning_cycle" = "first_token";
    let wdLimitMs = wd.firstTokenMs;
    let sawFirstEvent = false;
    const unref = (t: ReturnType<typeof setTimeout>) =>
      (t as unknown as { unref?: () => void }).unref?.();
    const fire = (
      kind: "idle" | "ceiling" | "first_token" | "repetition" | "rumination" | "reasoning_cycle",
      limitMs: number,
    ) => {
      wdKind = kind;
      wdLimitMs = limitMs;
      if (idleTimer) clearTimeout(idleTimer);
      if (ceilingTimer) clearTimeout(ceilingTimer);
      watchdog.abort();
    };
    const resetIdle = () => {
      if (!wd.enabled) return;
      if (idleTimer) clearTimeout(idleTimer);
      // Before the first stream event, allow the larger first-token budget (covers model load);
      // after it, the tight no-progress budget catches genuine mid-stream hangs.
      const limit = sawFirstEvent ? wd.noProgressMs : wd.firstTokenMs;
      const kind: "idle" | "first_token" = sawFirstEvent ? "idle" : "first_token";
      idleTimer = setTimeout(() => fire(kind, limit), limit);
      unref(idleTimer);
    };
    if (wd.enabled) {
      ceilingTimer = setTimeout(() => fire("ceiling", wd.maxCallMs), wd.maxCallMs);
      unref(ceilingTimer);
      resetIdle(); // arm for the prefill gap before the first event
    }
    // Mid-stream degenerate-repetition detection (WS3.4): two independent rolling tails —
    // channels are never mixed (interleaving would destroy periodicity). Checks throttle to
    // every REPETITION_CHECK_INTERVAL new chars per channel. On a hit, fire() records the
    // kind and the throw below is translated into StreamWatchdogError by the existing
    // watchdog-abort catch — the same path the timers use.
    const repMin = wd.enabled ? wd.repetitionRepeats : 0;
    const ruminationMin = wd.enabled ? wd.reasoningLoopLines : 0;
    const reasoningCycleMin = wd.enabled
      ? (wd.reasoningCycleRepeats ?? DEFAULT_STREAM_WATCHDOG.reasoningCycleRepeats ?? 0)
      : 0;
    let textTail = "";
    let reasoningTail = "";
    let textPending = 0;
    let reasoningPending = 0;
    // Family-adapter models stream tool-call markup as text/reasoning deltas (parsed
    // post-stream), so the tool-call reset never protects their arguments. Once a
    // channel's tail shows markup, its checks are suspended for the REST of the call —
    // degeneration inside tool markup falls to the max_call_ms ceiling instead.
    let textMarkup = false;
    let reasoningMarkup = false;
    const checkRepetition = (tail: string): void => {
      const hit = detectRepetition(tail, repMin);
      if (hit) {
        fire("repetition", 0);
        throw new Error(`degenerate repetition: unit of ${hit.unit.length} chars × ${hit.repeats}`);
      }
    };
    // Reasoning rumination detector (item 2): a normalized reasoning line recurring
    // reasoningLoopLines times (even non-consecutively) — the scattered-verbatim shape the
    // WS3.4 consecutive scan misses. One instance per call; self-disables at threshold 0.
    const ruminationDetector = new ReasoningLoopDetector(ruminationMin);
    const reasoningCycleDetector = new ReasoningCycleDetector(reasoningCycleMin);
    const req = applyEffort(
      {
        model: p.model,
        messages: p.messages,
        tools: p.toolSchemas,
        signal,
        modelFamily: this.opts.modelFamily,
        responseFormat: p.responseFormat,
        maxOutputTokens: p.maxOutputTokens,
      },
      p.effortOverride ?? this.currentEffort,
      this.noThinkModels,
    );
    try {
      for await (const ev of p.provider.chat(req)) {
        // First event of any kind ends the prefill phase; later gaps use the tight no-progress budget.
        sawFirstEvent = true;
        resetIdle();
        if (ev.type === "text-delta") {
          textBuf += ev.text;
          log.append({
            sessionId: p.sessionId,
            type: "model_call_chunk",
            payload: { callId, text: ev.text },
          });
          if (repMin > 0 && !textMarkup) {
            textTail = (textTail + ev.text).slice(-REPETITION_TAIL_CHARS);
            textPending += ev.text.length;
            if (textPending >= REPETITION_CHECK_INTERVAL) {
              textPending = 0;
              if (reasoningHasToolCallMarkup(textTail)) textMarkup = true;
              else checkRepetition(textTail);
            }
          }
        } else if (ev.type === "reasoning-delta") {
          reasoningBuf += ev.text;
          log.append({
            sessionId: p.sessionId,
            type: "reasoning_chunk",
            payload: { callId, text: ev.text },
          });
          // Maintain the shared reasoning tail + sticky markup latch whenever EITHER detector is
          // active (WS3.4 repetition OR rumination). Once tool-call markup appears, BOTH detectors
          // suspend for the rest of the call — family adapters stream tool-call args as reasoning.
          if ((repMin > 0 || ruminationMin > 0 || reasoningCycleMin > 0) && !reasoningMarkup) {
            reasoningTail = (reasoningTail + ev.text).slice(-REPETITION_TAIL_CHARS);
            reasoningPending += ev.text.length;
            if (reasoningPending >= REPETITION_CHECK_INTERVAL) {
              reasoningPending = 0;
              if (reasoningHasToolCallMarkup(reasoningTail)) reasoningMarkup = true;
              else if (repMin > 0) checkRepetition(reasoningTail);
            }
          }
          // Rumination push runs AFTER the markup-latch maintenance (so the <tool_call> opener
          // suspends it before repeated arg-lines reach threshold), and only while not suspended.
          if (!reasoningMarkup && ruminationDetector.push(ev.text)) {
            fire("rumination", 0);
            throw new Error("degenerate reasoning loop");
          }
          if (!reasoningMarkup && reasoningCycleDetector.push(ev.text)) {
            fire("reasoning_cycle", 0);
            throw new Error("exact long reasoning cycle");
          }
        } else if (ev.type === "tool-call-delta") {
          // Heartbeat: only resets the idle timer (above). Intentionally not logged —
          // a large file write emits hundreds and would flood the session log.
          // Also resets the repetition tails: argument streaming is structured output
          // where repetition is legitimate.
          textTail = "";
          reasoningTail = "";
          textPending = 0;
          reasoningPending = 0;
          reasoningCycleDetector.reset();
        } else if (ev.type === "tool-call") {
          // A tool call breaks prose continuity — without this reset, identical narration
          // across a legitimate multi-tool turn would accumulate past the span floor.
          textTail = "";
          reasoningTail = "";
          textPending = 0;
          reasoningPending = 0;
          reasoningCycleDetector.reset();
          toolCalls.push(ev.call);
          if (ev.recovered) anyRecovered = true;
          log.append({
            sessionId: p.sessionId,
            type: "tool_call_request",
            payload: { call: ev.call },
          });
        } else if (ev.type === "finish") {
          finishReason = ev.reason;
          servedModel = ev.model;
          if (ev.usage?.input) usage.input += ev.usage.input;
          if (ev.usage?.output) usage.output += ev.usage.output;
          // Reasoning precedes the answer, so log it before the end marker.
          if (reasoningBuf.length > 0) {
            log.append({
              sessionId: p.sessionId,
              type: "reasoning",
              payload: { callId, text: reasoningBuf },
            });
          }
          log.append({
            sessionId: p.sessionId,
            type: "model_call_end",
            payload: { callId, reason: ev.reason, usage: ev.usage, model: ev.model },
          });
        }
      }
    } catch (err) {
      // The watchdog aborted (the user did not) → surface as a distinct, non-retryable error.
      if (watchdog.signal.aborted && !p.abortSignal.aborted) {
        throw new StreamWatchdogError(wdLimitMs, wdKind);
      }
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (ceilingTimer) clearTimeout(ceilingTimer);
    }
    return { textBuf, reasoningBuf, toolCalls, finishReason, servedModel, anyRecovered, usage };
  }

  /** Emit a one-time-per-session notice when the served model differs from the requested one. */
  private maybeWarnServedModel(sessionId: string, requested: string, served?: string): void {
    if (!served || served.toLowerCase() === requested.toLowerCase()) return;
    if (this.warnedServed.has(sessionId)) return;
    this.warnedServed.add(sessionId);
    this.opts.log.append({
      sessionId,
      type: "notice",
      payload: {
        text: `requested "${requested}" but the server is running "${served}"`,
        level: "warn",
      },
    });
  }

  private async runFinishPass(
    decision: RouteDecision,
    history: Message[],
    systemPrompt: string,
    abortSignal: AbortSignal,
    sessionId: string,
    assembleContext = true,
    effortOverride?: EffortLevel,
    maxOutputTokens = 4096,
  ): Promise<FinishPassResult> {
    const { providers, log } = this.opts;
    const provider = providers.get(decision.choice.provider);
    // When reached from the main turn loop, the digest is already up-to-date from that
    // turn's primary call, so this re-assembly (with the finish-pass prompt) usually does
    // not re-evict; a large final tool result appended since then can still legitimately
    // trigger one more eviction + notice, which is correct.
    const messages = assembleContext
      ? await this.assembleMessages(
          sessionId,
          history,
          systemPrompt,
          provider,
          decision.choice.model,
          decision.choice.provider,
          abortSignal,
        )
      : [...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []), ...history];
    try {
      const result = await this.streamCall({
        sessionId,
        provider,
        model: decision.choice.model,
        messages,
        toolSchemas: [],
        abortSignal,
        tier: decision.tier,
        reason: decision.reason,
        effortOverride,
        maxOutputTokens,
      });
      this.maybeWarnServedModel(sessionId, decision.choice.model, result.servedModel);
      if (result.finishReason === "length") {
        this.finishPassLengthFailures.add(this.finishPassFailureKey(decision, maxOutputTokens));
        log.append({
          sessionId,
          type: "notice",
          payload: {
            text: `bounded finish pass reached its ${maxOutputTokens.toLocaleString()}-token output ceiling; discarded the partial result and kept the original answer`,
            level: "warn",
            kind: "finish_pass_length",
          },
        });
        return { status: "empty" };
      }
      const textBuf = result.textBuf;
      // A tool-less finish pass should produce prose, not a tool call. If the model emitted
      // tool-call markup anyway (a confused/amnesiac summary), its "summary" is untrustworthy —
      // discard it so the caller falls back to the original answer. Never leak raw markup.
      const stripped = stripToolCallMarkup(textBuf);
      if (stripped !== textBuf.trim() || result.toolCalls.length > 0) return { status: "empty" };
      return textBuf.trim().length > 0 ? { status: "ok", text: textBuf } : { status: "empty" };
    } catch (e) {
      if (abortSignal.aborted) return { status: "aborted" };
      if (e instanceof StreamWatchdogError) {
        log.append({
          sessionId,
          type: "notice",
          payload: {
            text: "bounded finish pass stopped by the stream watchdog; keeping the original answer",
            level: "warn",
            kind: "finish_pass_watchdog",
          },
        });
      }
      log.append({
        sessionId,
        type: "error",
        payload: { phase: "model", message: (e as Error).message },
      });
      return { status: "error", message: (e as Error).message };
    }
  }

  private finishPassFailureKey(decision: RouteDecision, maxOutputTokens: number): string {
    return `${providerModelKey(decision.choice.provider, decision.choice.model)}:${maxOutputTokens}`;
  }

  private automaticFinishPassAllowed(
    decision: RouteDecision,
    sessionId: string,
    maxOutputTokens = 4096,
  ): boolean {
    const key = this.finishPassFailureKey(decision, maxOutputTokens);
    if (!this.finishPassLengthFailures.has(key)) return true;
    const noticeKey = `${sessionId}:${key}`;
    if (!this.finishPassSuppressionNotices.has(noticeKey)) {
      this.finishPassSuppressionNotices.add(noticeKey);
      this.opts.log.append({
        sessionId,
        type: "notice",
        payload: {
          text: `skipped bounded finish pass for ${decision.choice.model}; an earlier pass for this served provider/model hit its output ceiling, so the original answer was kept without another discarded call`,
          level: "info",
          kind: "finish_pass_suppressed",
        },
      });
    }
    return false;
  }

  /** Tool-less synthesis run when a plan-mode turn thrashed on blocked tools: force the model
   *  to output a plan as text (no tools). Uses the finish-pass machinery. Returns null on
   *  error/abort, "" on markup-contaminated output (the runFinishPass guard). */
  private async runForcedPlanSynthesis(
    history: Message[],
    abortSignal: AbortSignal,
    sessionId: string,
    turnRouting: Pick<TurnContext, "specTurn" | "turnStartIndex">,
  ): Promise<string | null> {
    const loops = this.maxLoops();
    const base =
      this.opts.router.finishPass() ??
      this.opts.router.select({
        ...turnRouting,
        turnIndex: Number.isFinite(loops) ? loops : 1000,
        messages: history,
      });
    const decision: RouteDecision = { ...base, reason: `finish: plan-synthesis (${base.reason})` };
    let r = await this.runFinishPass(
      decision,
      history,
      FORCE_PLAN_SYNTHESIS_PROMPT,
      abortSignal,
      sessionId,
    );
    // Some local-family adapters emit a phantom tool call even when no tools were supplied. The
    // finish-pass guard correctly discards it as empty; give the model one clean resample with an
    // explicit correction before falling back. This remains tool-less and cannot mutate anything.
    if (r.status === "empty" && !abortSignal.aborted) {
      this.opts.log.append({
        sessionId,
        type: "notice",
        payload: {
          text: "plan mode: retrying tool-less plan synthesis after an empty or tool-contaminated response",
          level: "warn",
        },
      });
      r = await this.runFinishPass(
        { ...decision, reason: `${decision.reason} retry` },
        [
          ...history,
          {
            role: "user",
            content:
              "Your previous synthesis attempted a tool call or returned no prose. Do not call tools. Return only the concrete step-by-step implementation plan now.",
          },
        ],
        FORCE_PLAN_SYNTHESIS_PROMPT,
        abortSignal,
        sessionId,
      );
    }
    return r.status === "ok" ? r.text : null;
  }

  /** One capability per turn. Explicit config wins; "auto" latches PER MODEL ONLY ON EVIDENCE:
   *  the latch is set (permanently — it never flips) the first time this model's context window
   *  is actually known, using `decideCapability` on that window. While the window is still
   *  unknown, the turn provisionally gets "small" WITHOUT latching. This asymmetry exists
   *  because some providers (Ollama's `/api/ps`) only report a window for a model that is
   *  already LOADED, so turn 1 of a fresh session sees no window no matter how big the model
   *  is — latching on that absence would downgrade every such session to "small" forever. A
   *  single upward flip on turn 2 (before any meaningful KV-cache prefix has accrued, so the
   *  cost is negligible) beats a permanent, wrong downgrade. The preview sees everything loop
   *  0's `router.select` will see EXCEPT the version-pin reminder itself: that reminder is
   *  gated on the capability this function resolves, so including it here would be circular.
   *  It's a fixed ~40-token block; the residual divergence is accepted. `previewContent` is the
   *  caller's provisional last-user-message content (userInput + capability-independent
   *  reminders), not raw userInput. */
  private resolveTurnCapability(
    sessionId: string,
    history: Message[],
    previewContent: string,
    previewImages?: ImageRef[],
    routingHints?: TurnRoutingHints,
    choiceOverride?: ModelChoice,
  ): Capability {
    const mode = this.opts.capability?.() ?? "standard";
    const preview = choiceOverride
      ? { choice: choiceOverride }
      : this.opts.router.select({
          ...routingHints,
          turnIndex: 0,
          messages: [
            ...history,
            {
              role: "user",
              content: previewContent,
              ...(previewImages?.length ? { images: previewImages } : {}),
            },
          ],
        });
    const model = preview.choice.model;
    const providerName = preview.choice.provider;
    const selectedMode = this.opts.modelProfile?.(model, providerName)?.capability ?? mode;
    if (selectedMode !== "auto") return selectedMode;
    const key = providerModelKey(providerName, model);
    const latched = this.capabilityByProviderModel.get(key);
    if (latched) return latched;

    const reportedInfo = this.opts.modelContextInfo?.(model, providerName);
    const reportedWindow = normalizeContextLength(reportedInfo?.window);
    const legacyWindow = normalizeContextLength(
      this.opts.modelContextLength?.(model, providerName),
    );
    const info: WindowInfo | undefined =
      reportedInfo && reportedWindow !== undefined
        ? { ...reportedInfo, window: reportedWindow }
        : legacyWindow !== undefined
          ? { window: legacyWindow, source: "loaded" }
          : undefined;

    if (info === undefined) {
      // No evidence yet: serve "small" for this turn only — do NOT latch.
      if (!this.provisionalSmallKeys.has(key)) {
        this.provisionalSmallKeys.add(key);
        this.opts.log.append({
          sessionId,
          type: "notice",
          payload: {
            text: `capability: small surface for ${model} (context window unknown — will upgrade if a larger window is detected)`,
            level: "info",
          },
        });
      }
      return "small";
    }

    const cap = decideCapability(info.window);
    // Latch permanently ONLY on an authoritative loaded window. An architectural window (the
    // /api/show ceiling) grants the surface for this turn but stays provisional, so a later
    // loaded window can still correct it — including downgrading standard → small.
    if (info.source === "loaded") {
      this.capabilityByProviderModel.set(key, cap);
    }

    if (cap === "standard") {
      // One-time upgrade notice on the provisional-small → standard transition.
      if (this.provisionalSmallKeys.has(key) && !this.standardAnnounced.has(key)) {
        this.standardAnnounced.add(key);
        this.provisionalSmallKeys.delete(key);
        this.opts.log.append({
          sessionId,
          type: "notice",
          payload: {
            text: `capability: standard surface for ${model} (context window detected)`,
            level: "info",
          },
        });
      }
    } else if (info.source === "loaded") {
      // Authoritative small: announce the latched small surface (as before). Architectural-small
      // stays quiet — it is provisional and a loaded window may still arrive.
      this.opts.log.append({
        sessionId,
        type: "notice",
        payload: {
          text: `capability: small surface for ${model} (${SMALL_TOOL_ROSTER.size} tools, distilled prompt) — set capability: standard to override`,
          level: "info",
        },
      });
    }
    return cap;
  }

  /** Public turn entry point. Runs the turn, then snapshots the session's history+todos
   *  on every exit path (success, stop, or error) so resume/fork stay current. */
  async runTurn(
    sessionId: string,
    userInput: string,
    signal?: AbortSignal,
    source?: string,
    title?: string,
    attachments?: ImageRef[],
    routingHints?: TurnRoutingHints,
  ): Promise<RunTurnResult> {
    try {
      const result = await this.runTurnInner(
        sessionId,
        userInput,
        signal,
        source,
        title,
        attachments,
        routingHints,
      );
      if (
        this.opts.suggestLearnedPlaybook &&
        source === undefined &&
        !(this.opts.planMode?.() ?? false) &&
        shouldSuggestPlaybook(result)
      ) {
        this.opts.log.append({
          sessionId,
          type: "notice",
          payload: {
            text: playbookSuggestionText(result),
            level: "info",
            kind: "learn_playbook_suggestion",
            toolCalls: result.successfulToolCalls + result.failedToolCalls,
            failedToolCalls: result.failedToolCalls,
            unproductiveToolCalls: result.unproductiveToolCalls ?? 0,
          },
        });
      }
      return result;
    } finally {
      this.auditCallGates.delete(sessionId);
      this.snapshotSession(sessionId);
    }
  }

  private async runTurnInner(
    sessionId: string,
    userInput: string,
    signal?: AbortSignal,
    /** Non-user origin of this turn (e.g. "orchestration-worker", "subagent"); tags the
     *  user_input event so generated sub-task prompts are distinguishable from real input. */
    source?: string,
    /** Human-readable task title for a down-passed worker turn; shown in the TUI handoff line
     *  (#152). Undefined for real user input and the task-tool subagent path. */
    title?: string,
    attachments?: ImageRef[],
    routingHints?: TurnRoutingHints,
  ): Promise<RunTurnResult> {
    const { log, providers, dispatcher, tools, router, resolvePermission } = this.opts;
    const projectDir =
      typeof this.opts.projectDir === "function" ? this.opts.projectDir() : this.opts.projectDir;
    const history = this.getHistory(sessionId);

    // Capability-independent turn-content fragments first: neither the sticky-skill
    // machinery nor the todo re-injection depends on the capability being resolved below,
    // so compute them up front and fold them into the route preview loop 0 will actually see.
    // The todo-reinject flag is a consuming read — pull it exactly once, here.
    const visibilityComplaint = /\b(?:invisible|not visible|can(?:not|'t) see|hard to see)\b/i.test(
      userInput,
    );
    const triggeredSkills = this.opts.triggeredSkillReminders?.(userInput) ?? [];
    const currentSkills = triggeredSkills.map((skill) =>
      typeof skill === "string" ? skill : skill.reminder,
    );
    const triggeredSkillNames = triggeredSkills.flatMap((skill) =>
      typeof skill === "string" ? [] : [skill.name],
    );
    const planNow = this.opts.planMode?.() ?? false;
    const sticky = stickyReminders(
      currentSkills,
      planNow,
      this.wasPlanModeBySession.get(sessionId) ?? false,
      this.arcSkillsBySession.get(sessionId) ?? [],
    );
    this.arcSkillsBySession.set(sessionId, sticky.arc);
    this.wasPlanModeBySession.set(sessionId, planNow);
    // Retire a fully-completed working list at the turn boundary: a done list is not current work.
    // Carrying it forward lets the post-compaction re-injector feed a finished (often unrelated)
    // checklist back to the model as its live todo list, which the model then resurrects — muse2: a
    // completed scaffold list reappeared on a later "fix a few things" turn and was regressed to a
    // stuck 4/8 · paused. Incomplete lists are preserved (their re-injection is the intended feature).
    const carriedTodos = this.latestTodosBySession.get(sessionId) ?? [];
    if (carriedTodos.length > 0 && carriedTodos.every((todo) => todo.status === "completed")) {
      this.latestTodosBySession.delete(sessionId);
      this.todoReinjectBySession.delete(sessionId);
    }
    const hasTodoReinject = this.todoReinjectBySession.delete(sessionId);
    const todoReminder = hasTodoReinject
      ? renderTodoReminder(this.latestTodosBySession.get(sessionId) ?? [])
      : undefined;
    const voiceReminder = this.opts.voiceReminder?.() ?? "";

    const provisionalContent = [
      userInput,
      ...sticky.inject,
      ...(todoReminder ? [todoReminder] : []),
      ...(voiceReminder ? [voiceReminder] : []),
    ].join("\n\n");
    let turnCapability = this.resolveTurnCapability(
      sessionId,
      history,
      provisionalContent,
      attachments,
      routingHints,
    );
    let systemPrompt =
      turnCapability === "small" && this.opts.smallSystemPrompt
        ? this.opts.smallSystemPrompt()
        : this.opts.systemPrompt();
    try {
      await this.opts.checkpoints?.begin(
        sessionId,
        userInput,
        history.length,
        this.latestTodosBySession.get(sessionId),
      );
    } catch {
      // checkpoint capture is advisory; never let it break a turn
    }
    let approvedPlanTodos: TodoItem[] = [];
    let approvedPlanDocument = "";
    if (!source && !planNow && userInput.trim() === PLAN_APPROVAL_MESSAGE) {
      const approvedPlan = [...history]
        .reverse()
        .find((message) => message.role === "assistant" && message.content.trim());
      approvedPlanDocument = approvedPlan?.content ?? "";
      const stepTitles = approvedPlan ? approvedPlanStepTitles(approvedPlan.content) : [];
      approvedPlanTodos = stepTitles.map((content, index) => ({
        content,
        status: index === 0 ? "in_progress" : "pending",
      }));
    }
    if (!source && !planNow && approvedPlanTodos.length === 0) {
      approvedPlanDocument = approvedSpecExecutionDocument(userInput, history) ?? "";
      if (!approvedPlanDocument) {
        const specPath = userInput.trim().match(APPROVED_SPEC_EXECUTION)?.[1];
        if (specPath) {
          const absolute = resolve(projectDir, specPath);
          const rel = relative(projectDir, absolute);
          if (rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) {
            try {
              approvedPlanDocument = await readFile(absolute, "utf8");
            } catch {
              // Older sessions may no longer have the referenced draft. Keep the bounded
              // fallback todo contract rather than failing the implementation turn.
            }
          }
        }
      }
      approvedPlanTodos = approvedSpecExecutionStepTitles(userInput, history).map(
        (content, index) => ({
          content,
          status: index === 0 ? "in_progress" : "pending",
        }),
      );
    }
    const approvedTodoContract: SeededTodoContract =
      approvedPlanTodos.length > 0
        ? seededTodoContract(approvedPlanDocument)
        : (this.todoContractBySession.get(sessionId) ?? {
            expectedFiles: [],
            verification: [],
          });
    if (approvedPlanTodos.length > 0) {
      this.todoContractBySession.set(sessionId, approvedTodoContract);
    }
    // Assemble the final content in fragment order: userInput, version-pin reminder, sticky
    // injects, todo reminder, plan-mode reminder, location grounding.
    let turnContent = userInput;
    // Plan/review prompts often quote JSON, CSV, or forecast requirements from the underlying
    // spec. They are still architecture/planning work, not standalone retrieval exports.
    const turnRetrievalKind = planNow ? null : retrievalEfficiencyKind(userInput);
    const exactFetchedArtifactRequested = !planNow && expectsExactFetchedArtifact(userInput);
    const retrievalReminder = planNow ? "" : retrievalEfficiencyReminder(userInput);
    if (retrievalReminder) turnContent = `${turnContent}\n\n${retrievalReminder}`;
    const reminded = this.remindedPinsBySession.get(sessionId) ?? new Set<string>();
    const vp = versionPinReminderFor(
      userInput,
      isCodingTask(userInput),
      (this.opts.webToolsEnabled?.() ?? true) && turnCapability !== "small",
    );
    if (vp && !reminded.has(vp.pin)) {
      turnContent = `${userInput}\n\n${vp.reminder}`;
      reminded.add(vp.pin);
      this.remindedPinsBySession.set(sessionId, reminded);
    }
    if (sticky.inject.length > 0) {
      turnContent = [turnContent, ...sticky.inject].join("\n\n");
    }
    if (todoReminder) {
      turnContent = `${turnContent}\n\n${todoReminder}`;
    }
    if (approvedTodoContract.verification.includes("render")) {
      turnContent = `${turnContent}\n\n<system-reminder>The approved spec or plan includes a user-interface presentation requirement. A build or server launch does not prove it rendered or behaved correctly. Use render_check to verify the UI actually renders: pass launchCommand (your existing dev command, e.g. \`bun run dev -- --port 5173\`), a localhost url for the changed feature's route, and expectedText unique to that feature so a wrong route cannot pass. For a primary interaction also pass expectedControl and expectedAfterText. If no supported system browser is available, render_check reports the check unverified — mark the render verification unverified rather than claiming it works.</system-reminder>`;
    } else if (reportsInteractiveRenderDefect(userInput)) {
      // A bug-report turn on already-running UI: reproduce the symptom with render_check BEFORE
      // editing. A capable model did this and localized/fixed the bug; a weak model skipped it and
      // spun (render2). Suppressed above when a render contract reminder already covers this turn.
      turnContent = `${turnContent}\n\n<system-reminder>You're being asked to fix a defect in software that is already running. Before editing, reproduce the reported symptom with render_check so you know exactly what is wrong and can prove the fix: launch the app (launchCommand, e.g. \`bun run dev -- --port 5173\`), open the affected route (url), and for a misbehaving interaction pass expectedControl (the control the user acts on) plus expectedAfterText (what should appear after acting). A reproduction that fails the way the user describes localizes the bug; after your edit, re-run the same render_check to confirm it now passes. If no supported system browser is available, render_check reports the check unverified — proceed from the code and record the runtime check as unverified.</system-reminder>`;
    }
    // Plan-mode guidance rides the user turn, not the system prompt (see PLAN_MODE_REMINDER).
    // Reuse the turn's captured planNow rather than re-reading opts.planMode() here, so this
    // stays consistent with sticky/wasPlanModeBySession even if the toggle flips mid-turn.
    if (planNow) {
      turnContent = `${turnContent}\n\n${PLAN_MODE_REMINDER}`;
    }
    // Re-ground the model each coding turn on where the project already lives (recomputed from
    // disk), so a follow-up turn cannot mistake a subdir project for an empty dir and re-scaffold
    // over it (ctest item 1). Subdir-only; fresh/cwd projects emit nothing.
    if (isCodingTask(userInput)) {
      const grounding = locationGroundingReminder(await scanProject(projectDir));
      if (grounding) turnContent = `${turnContent}\n\n${grounding}`;
    }
    // Keep personality guidance nearest the requested response. transcriptUserInput strips this
    // internal reminder from UI/event transcript text.
    if (voiceReminder) turnContent = `${turnContent}\n\n${voiceReminder}`;
    // A follow-up retrieval may legitimately reuse an identifier established by the immediately
    // preceding turn (for example, geocoded coordinates). Keep that evidence only when it names
    // the current request's distinctive entity; unrelated prior-turn coordinates remain blocked.
    const priorTurnEvidence = turnRetrievalKind !== null ? currentTurnEvidence(history, -1) : "";
    const currentIdentityAnchor = artifactIdentityAnchor(userInput);
    const priorTurnIdentifierEvidence =
      currentIdentityAnchor &&
      priorTurnEvidence.toLowerCase().includes(currentIdentityAnchor.toLowerCase())
        ? priorTurnEvidence
        : "";
    const priorFetchedJsonUrls = fetchedJsonUrlsFromEvidence(priorTurnEvidence);
    const reusableFetchedJsonUrl = exactFetchedArtifactRequested
      ? priorFetchedJsonUrls.at(-1)
      : undefined;
    if (reusableFetchedJsonUrl) {
      turnContent = [
        turnContent,
        [
          "<system-reminder>Reusable retrieval: the immediately preceding turn successfully",
          `fetched complete JSON from ${reusableFetchedJsonUrl}. If that is the payload requested`,
          "now, call save_fetched_json with that URL and the requested path immediately; do not",
          "search or fetch it again. If it was only intermediate lookup data, continue with",
          "web_search/web_fetch until the requested payload is cached.</system-reminder>",
        ].join(" "),
      ].join("\n\n");
    }
    if (visibilityComplaint)
      turnContent +=
        "\n\n<system-reminder>The user reports a visibility defect. DOM presence, a passing build, or text-only render_check cannot resolve it. Use render_check with expectedControl identifying the affected control and expectedText identifying the page. Inspect geometry, occlusion, computed foreground/background/placeholder contrast, and the supplied image if available. Do not dismiss the report as a false alarm or timing issue without reproducing the actual control visibility.</system-reminder>";
    const turnStartIndex = history.length;
    const userRequest = routingHints?.isolatedPlanStep
      ? null
      : routingHints?.userRequest === undefined
        ? userInput
        : routingHints.userRequest;
    if (routingHints?.specTurn || routingHints?.isolatedPlanStep) {
      const requests = originalUserRequests([
        ...history,
        { role: "user", content: userInput, userRequest },
      ]);
      turnContent += `\n\n${acceptanceReminder(requests)}`;
    }
    if (routingHints?.isolatedPlanStep) {
      const state = this.emptyTrimState();
      state.boundaryIndex = history.length;
      state.digest = { text: "", coveredThroughIndex: history.length };
      this.trimBySession.set(sessionId, state);
      if (routingHints.completedStepEvidence)
        turnContent += `\n\nCompleted step evidence:\n${routingHints.completedStepEvidence}`;
    }
    history.push({
      turnOrigin: true,
      userRequest,
      role: "user",
      content: turnContent,
      ...(attachments?.length ? { images: attachments } : {}),
    });
    log.append({
      sessionId,
      type: "user_input",
      payload: { text: transcriptUserInput(userInput), source, title },
    });
    // Treat deterministic plan-to-todo conversion as the first action of the approved
    // implementation turn. This keeps event trajectories correctly attributed while giving the
    // model a durable checklist before it can make its first real tool call.
    if (approvedPlanTodos.length > 0) {
      this.seedTodoList(sessionId, approvedPlanTodos);
      history.push({
        role: "user",
        content:
          "<system-reminder>Cleetus has seeded the approved plan as the live working checklist. " +
          "Do not leave it at its initial state while moving through the plan. At each named step " +
          "boundary, call todo_write with the full list: mark only evidenced work completed and " +
          "put the step you are actually starting in_progress. Keep unmet or unverified work " +
          "pending; do not bulk-complete the list at the end unless every item is supported by " +
          "the repository and verification results.</system-reminder>",
      });
    }
    if (triggeredSkillNames.length > 0) {
      log.append({
        sessionId,
        type: "notice",
        payload: {
          text: `auto-invoked ${triggeredSkillNames.length === 1 ? "skill" : "skills"}: ${triggeredSkillNames.join(", ")}`,
          level: "info",
          kind: "skill_auto_invoked",
          skills: triggeredSkillNames,
        },
      });
    }

    let assistantText = "";
    let toolCallCount = 0;
    let successfulToolCalls = 0;
    let failedToolCalls = 0;
    let unproductiveToolCalls = 0;
    let successfulEdits = 0;
    let failedWrites = 0;
    const verificationResults = new Map<string, VerificationResult>();
    const repeatedVerificationRequests = new Map<string, number>();
    const successfulSetupActions = new Map<string, string>();
    // Verification may be requested repeatedly by implementation/audit loops. Reuse an identical
    // result until a structured source edit lands; unlike durableProgressEpoch, verification
    // itself does not advance this epoch.
    const verificationEpochs = new Map<string, number>();
    const verificationReplayContexts = new Map<string, string>();
    let trackedEditEpoch = 0;
    const turnEditedPaths = new Set<string>();
    const editedFileSnapshots = new Map<string, EditedFileSnapshot>();
    const turnInspectedPaths = new Set<string>();
    const postVerificationInspectedPaths = new Set<string>();
    // Count redundant post-verification re-inspections that were blocked without an intervening
    // edit. A single re-read is normal (locating the exact edit point before applying a fix), so it
    // is nudged, not fatal; only sustained re-reading with no edit closes tool access.
    let postVerificationInspectionBlocks = 0;
    const recentDurableActions: string[] = [];
    let lastNarration = "";
    let latestDiagnostics = "";
    let durableProgressEpoch = 0;
    let budgetExtensions = 0;
    const rememberAction = (action: string) => {
      recentDurableActions.push(action);
      if (recentDurableActions.length > 8) recentDurableActions.shift();
      durableProgressEpoch++;
    };
    const progressSummary = () =>
      renderProgressSummary({
        editedPaths: [...turnEditedPaths],
        recentActions: recentDurableActions,
        lastNarration,
        latestDiagnostics,
        verificationResults: [...verificationResults.values()],
      });
    const userSignal = signal ?? new AbortController().signal;
    const deadlineMs = turnDeadlineMs(source ?? "", this.opts.workerTurnMs);
    const turnDeadline = new AbortController();
    // Count only agent work. Permission prompts are user-controlled suspension points and may sit
    // unanswered for minutes; charging that time to the worker made the watchdog terminate the
    // task immediately after the user finally approved it.
    let deadlineRemainingMs = deadlineMs;
    let deadlineStartedAt = 0;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = () => {
      if (deadlineMs <= 0 || userSignal.aborted || turnDeadline.signal.aborted) return;
      deadlineStartedAt = Date.now();
      deadlineTimer = setTimeout(() => turnDeadline.abort(), Math.max(0, deadlineRemainingMs));
    };
    const pauseDeadline = () => {
      if (!deadlineTimer) return;
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      deadlineRemainingMs = Math.max(0, deadlineRemainingMs - (Date.now() - deadlineStartedAt));
    };
    armDeadline();
    const abortSignal =
      deadlineMs > 0 ? AbortSignal.any([userSignal, turnDeadline.signal]) : userSignal;

    try {
      // Fix F: hoist tool schemas to a single call before the loop — tools don't change during a turn
      const taskCapabilityTools =
        turnRetrievalKind === null ? new Set<string>() : SMALL_RETRIEVAL_TOOL_ROSTER;
      const capabilityToolSchemas = this.buildToolSchemas(turnCapability, taskCapabilityTools);
      const escalationRequestSupported = router.supportsEscalationRequest?.() ?? false;
      const modeAwareToolSchemas = escalationRequestSupported
        ? capabilityToolSchemas
        : capabilityToolSchemas.filter((tool) => tool.name !== "request_escalation");
      let toolSchemas: ToolSchema[] = exactFetchedArtifactRequested
        ? modeAwareToolSchemas.filter((tool) => EXACT_ARTIFACT_TOOL_ROSTER.has(tool.name))
        : modeAwareToolSchemas;
      let toolSchemaTokens = estimateTokens(JSON.stringify(toolSchemas));

      // Fix C: track whether we exited the loop with a clean (non-tool-calls) finish
      let completedNormally = false;

      let planBlockedStreak = 0;
      let forcePlanSynthesis = false;
      let usedTools = false;
      let spentTokens = 0;
      let tokensSinceLastEdit = 0;
      let previousNoProgressInput: number | undefined;
      const recordUsage = (usage: { input: number; output: number }) => {
        spentTokens += usage.input + usage.output;
        tokensSinceLastEdit += incrementalProgressTokens(usage, previousNoProgressInput);
        previousNoProgressInput = usage.input;
      };
      let budgetExhausted = false;
      let convergenceFinalRequested = false;
      let convergenceToolViolations = 0;
      let prematureStopContinuations = 0;
      let completionAuditRequested = false;
      let auditModelCalls = 0;
      let auditToolAttempts = 0;
      let auditRepairStarted = false;
      let auditRepairVerified = false;
      let auditLimit: string | null = null;
      let auditLimitReminderSent = false;
      const auditLimits = this.opts.completionAuditLimits ?? { modelCalls: 6, toolAttempts: 12 };
      const closeAudit = (reason: string) => {
        if (auditLimit) return;
        auditLimit = reason;
        convergenceFinalRequested = true;
        stoppedReason = "no_progress";

        log.append({
          sessionId,
          type: "notice",
          payload: { kind: "completion_audit_limit", level: "warn", text: reason },
        });
      };
      let todoCompletionReconciliationRequested = false;
      let todoReconciliationPending = false;
      // The last active-list change was a todo_write in this turn. Do not infer completion from
      // prose alone: models often end with a step-local summary after writing their checklist.
      let workingTodosWrittenThisTurn = false;
      let trackerPhaseReminder: {
        priorTodos: TodoItem[];
        from: number;
        to: number;
      } | null = null;
      let completionEvidenceWarningEmitted = false;
      let smokeAttempted = false;
      const fetchedJsonUrls = new Set<string>();
      const fullyVisibleFetchedJsonUrls = new Set<string>();
      const directlyDownloadedJsonUrls = new Set<string>();
      const artifactWrittenPaths = new Set<string>();
      const fidelityValidatedPaths = new Set<string>();
      let latestFetchedJsonSource: {
        url: string;
        raw: string;
        value: unknown;
        identityGrounded: boolean;
      } | null = null;
      let artifactFinalSynthesisRequested = false;
      let deterministicArtifactCompletion: string | null = null;
      let artifactFidelityContinuationRequested = false;
      // A turn gets at most one model-based finalization/copy-edit pass. The primary working
      // loop may already have produced a good answer; stacking speed synthesis, grounding
      // repair, and personality correction can cost more than the task and introduce new drift.
      let postProcessingAttempted = false;
      let retrievalFetchNudges = 0;
      let dataArtifactInventoryNudgeSent = false;
      let singleInspectionRoundStreak = 0;
      let inspectionBatchNudgeSent = false;
      let budgetWarned = false;
      let progressEpochAtBudgetBoundary = 0;
      let noProgressStop = false;
      let repeatedProbeStop = 0;
      let repeatedProbeAdvice = "";
      const repeatedProbeGuard = new RepeatedProbeGuard(
        Math.max(8, (this.opts.loopGuard?.().noProgressThreshold ?? 4) * 2),
      );
      let noProgressGraceUsed = false;
      let thrashStop = false;
      let thrashSig: string | null = null;
      // A verification/test check that will not converge, on a turn that built real work, is
      // recorded as an unresolved limitation and the work is delivered — rather than discarding the
      // whole turn with a hard "did not complete" thrash stop.
      let thrashVerificationLimit: string | null = null;
      let hiddenStop = false;
      let stoppedReason: RunTurnResult["stoppedReason"];
      const workerBudget =
        source === "orchestration-worker" ? (this.opts.workerTurnTokens ?? 0) : 0;
      let workerSoftBudget = workerBudget;
      const workerHardBudget =
        workerBudget > 0
          ? Math.max(workerBudget, workerBudget * (this.opts.workerMaxTokenMultiplier ?? 1.5))
          : 0;
      const workerNoProgress =
        source === "orchestration-worker" && this.opts.workerRequiresEdit !== false
          ? (this.opts.workerNoProgressTokens ?? 0)
          : 0;
      const workerRequiresEdit =
        source === "orchestration-worker" && this.opts.workerRequiresEdit === true;
      let readOnlyToolRoundsBeforeFirstEdit = 0;
      let editNudgeSent = false;
      const thrashRepeats =
        source === "orchestration-worker"
          ? (this.opts.workerThrashRepeats?.() ?? 0)
          : (this.opts.loopGuard?.().cmdFailAbort ?? 0);
      const protectExisting =
        source === "orchestration-worker" && (this.opts.protectExistingFiles?.() ?? false);
      const guardPendingScope =
        source === "orchestration-worker" && (this.opts.guardPendingScope?.() ?? false);
      const capLimit = this.maxLoops();
      let routingToolCalls = 0;
      let routingToolFailures = 0;
      let routingConsecutiveToolFailures = 0;
      let routingConsecutiveToolSuccesses = 0;
      let routingRetrievalSearches = 0;
      let routingRetrievalStalled = false;
      let retrievalIdentifierEvidence = priorTurnIdentifierEvidence;
      let identifierResolutionSearchEligibleLoop: number | null = null;
      let identifierResolutionSearchCreditAvailable = true;
      let routingSourceEditEpoch = 0;
      let routingVerifiedSourceEditEpoch = 0;
      let routingFailedVerificationEpoch = 0;
      let routingRecoveryLeaseActive = false;
      let previousRoutedTier: RouteDecision["tier"] = null;
      const recordRoutingToolOutcome = (ok: boolean): void => {
        routingToolCalls++;
        if (ok) {
          routingConsecutiveToolFailures = 0;
          routingConsecutiveToolSuccesses++;
        } else {
          routingToolFailures++;
          routingConsecutiveToolFailures++;
          routingConsecutiveToolSuccesses = 0;
        }
      };

      // One-shot: a reasoning-cycle/rumination watchdog abort injects a decisive nudge and retries
      // the call (see loopBreakNudge) instead of ending the turn cold. Capped at one retry so an
      // unbreakable deadlock still stops rather than looping forever.
      let loopBreakRetried = false;
      // One idle-stream retry per user turn, on the exact same request/model. Do
      // not reroute or replay tools; failed streamCall buffers never reach dispatch.
      let idleStreamRetried = false;
      const streamWithIdleRetry = async (params: Parameters<AgentRuntime["streamCall"]>[0]) => {
        try {
          return await this.streamCall(params);
        } catch (error) {
          if (
            !(error instanceof StreamWatchdogError) ||
            error.kind !== "idle" ||
            idleStreamRetried ||
            params.abortSignal.aborted
          )
            throw error;
          idleStreamRetried = true;
          log.append({
            sessionId,
            type: "notice",
            payload: {
              text: `The stream from ${params.model} went silent; retrying once on the same model. Completed tool work is preserved.`,
              level: "warn",
              kind: "stream_idle_retry",
            },
          });
          return this.streamCall({ ...params, reason: `${params.reason} (retry-idle)` });
        }
      };
      for (let loop = 0; loop < capLimit; loop++) {
        if (
          identifierResolutionSearchEligibleLoop !== null &&
          loop > identifierResolutionSearchEligibleLoop
        ) {
          identifierResolutionSearchEligibleLoop = null;
          identifierResolutionSearchCreditAvailable = false;
        }
        if (forcePlanSynthesis) break;
        if (completionAuditRequested && !auditLimit) {
          if (auditModelCalls >= auditLimits.modelCalls)
            closeAudit(`audit exceeded ${auditLimits.modelCalls} model calls`);
        }
        if (auditLimit && !auditLimitReminderSent) {
          auditLimitReminderSent = true;
          history.push({
            role: "user",
            content: `<system-reminder>Completion audit stopped: ${auditLimit}. Tool access is closed; report unresolved requirements as unverified.</system-reminder>`,
          });
        }
        let activeToolSchemas =
          convergenceFinalRequested || artifactFinalSynthesisRequested ? [] : toolSchemas;
        // Fix B: move selector/provider resolution inside try/catch so failures are logged
        // and history is kept consistent via the same terminal-assistant-message path as Fix A.
        let textBuf = "";
        let reasoningText = "";
        let anyRecovered = false;
        const pendingToolCalls: { id: string; name: string; args: unknown }[] = [];
        let finishReason: "stop" | "tool-calls" | "length" | "error" = "stop";
        let routedDecision: RouteDecision | null = null;

        try {
          // Fix B: selector and providers.get moved inside try block
          const routeContext = {
            ...routingHints,
            turnIndex: loop,
            messages: history,
            turnStartIndex,
            toolProgress: {
              calls: routingToolCalls,
              failures: routingToolFailures,
              consecutiveFailures: routingConsecutiveToolFailures,
              consecutiveSuccesses: routingConsecutiveToolSuccesses,
              retrievalStalled: routingRetrievalStalled,
            },
            routingState: {
              previousTier: previousRoutedTier,
              sourceEditEpoch: routingSourceEditEpoch,
              verifiedSourceEditEpoch: routingVerifiedSourceEditEpoch,
              failedVerificationEpoch: routingFailedVerificationEpoch,
              completionAuditActive: completionAuditRequested,
              recoveryLeaseActive: routingRecoveryLeaseActive,
            },
          };
          let decision = router.select(routeContext);
          let choice = decision.choice;
          let provider = providers.get(choice.provider);
          let messages = await this.assembleMessages(
            sessionId,
            history,
            systemPrompt,
            provider,
            choice.model,
            choice.provider,
            abortSignal,
            toolSchemaTokens,
          );
          const contextCfg = this.opts.context?.() ?? DEFAULT_CONTEXT;
          const contextLength = normalizeContextLength(
            this.opts.modelContextLength?.(choice.model, choice.provider),
          );
          const capacityTokens = Math.max(
            1,
            budgetBase({
              contextLength,
              configBudgetTokens: contextCfg.budgetTokens,
              maxBudgetTokens:
                this.opts.modelProfile?.(choice.model, choice.provider)?.max_budget_tokens ??
                contextCfg.maxBudgetTokens,
            }) - contextCfg.responseReserveTokens,
          );
          const contextualDecision = router.select({
            ...routeContext,
            contextPressure: {
              inputTokens: sumTokens(messages, 0, messages.length) + toolSchemaTokens,
              capacityTokens,
            },
          });
          const routeChanged =
            contextualDecision.choice.provider !== choice.provider ||
            contextualDecision.choice.model !== choice.model;
          decision = contextualDecision;
          if (routeChanged) {
            choice = decision.choice;
            provider = providers.get(choice.provider);
            messages = await this.assembleMessages(
              sessionId,
              history,
              systemPrompt,
              provider,
              choice.model,
              choice.provider,
              abortSignal,
              toolSchemaTokens,
            );
          }
          const routedCapability = this.opts.modelProfile
            ? this.resolveTurnCapability(
                sessionId,
                history,
                provisionalContent,
                attachments,
                routingHints,
                choice,
              )
            : turnCapability;
          if (routedCapability !== turnCapability) {
            turnCapability = routedCapability;
            systemPrompt =
              turnCapability === "small" && this.opts.smallSystemPrompt
                ? this.opts.smallSystemPrompt()
                : this.opts.systemPrompt();
            toolSchemas = this.buildToolSchemas(turnCapability, taskCapabilityTools)
              .filter((tool) => escalationRequestSupported || tool.name !== "request_escalation")
              .filter(
                (tool) =>
                  !exactFetchedArtifactRequested || EXACT_ARTIFACT_TOOL_ROSTER.has(tool.name),
              );
            toolSchemaTokens = estimateTokens(JSON.stringify(toolSchemas));
            activeToolSchemas =
              convergenceFinalRequested || artifactFinalSynthesisRequested ? [] : toolSchemas;
            messages = await this.assembleMessages(
              sessionId,
              history,
              systemPrompt,
              provider,
              choice.model,
              choice.provider,
              abortSignal,
              toolSchemaTokens,
            );
          }
          if (
            routingRetrievalStalled &&
            (decision.tier === "large" || decision.lease === "recovery")
          ) {
            messages = [
              ...messages,
              { role: "system" as const, content: retrievalRecoveryReminder() },
            ];
          }
          // Once a data artifact has been validated, the remaining job is narrow synthesis.
          // Give smaller models a current-turn evidence packet instead of asking them to recover
          // the contract from prior turns, assistant narration, and duplicated raw payloads.
          if (artifactFinalSynthesisRequested) {
            postProcessingAttempted = true;
            messages = groundedSynthesisMessages({
              systemPrompt,
              request: userInput,
              evidence: currentTurnEvidence(history, turnStartIndex),
            });
          }
          previousRoutedTier = decision.tier;
          routedDecision = decision;
          if (decision.lease === "recovery") {
            // Reset the success streak only on the actual grant (the transition from not-held
            // to held), not on every iteration the lease continues to reassert itself —
            // `recovery_in_progress` is itself one of the reasons that makes `decision.lease`
            // "recovery" again on every subsequent held iteration, so resetting unconditionally
            // here would wipe the streak before each new tool call ever runs, and the lease
            // could never reach `deescalateAfterSuccesses` above 1. `routingRecoveryLeaseActive`
            // at this point still holds its value from before this iteration's update, so it
            // tells us whether this is a fresh grant.
            if (!routingRecoveryLeaseActive) {
              routingConsecutiveToolSuccesses = 0;
            }
            routingRecoveryLeaseActive = true;
          } else if (routingRecoveryLeaseActive && decision.tier === "small") {
            // The router's own evaluateSmart decided the success streak has cleared the
            // threshold and handed back to small — actually release the lease.
            routingRecoveryLeaseActive = false;
          }

          try {
            let res: Awaited<ReturnType<typeof this.streamCall>>;
            try {
              res = await streamWithIdleRetry({
                sessionId,
                provider,
                model: choice.model,
                messages,
                toolSchemas: activeToolSchemas,
                abortSignal,
                tier: decision.tier,
                reason: decision.reason,
              });
            } catch (err) {
              if (abortSignal.aborted) throw err;
              if (isNoThinkingError(err) && !this.noThinkModels.has(choice.model)) {
                // This model 400'd on a reasoning request. Memoize it so applyEffort drops
                // reasoning_effort from here on, and resample once without it. Side-effect-free
                // (no tool ran), like the 5xx retry below.
                this.noThinkModels.add(choice.model);
                this.opts.log.append({
                  sessionId,
                  type: "notice",
                  payload: {
                    text: `${choice.model} doesn't support thinking — retrying without reasoning effort.`,
                    level: "warn",
                  },
                });
                res = await streamWithIdleRetry({
                  sessionId,
                  provider,
                  model: choice.model,
                  messages,
                  toolSchemas: activeToolSchemas,
                  abortSignal,
                  tier: decision.tier,
                  reason: `${decision.reason} (retry-no-thinking)`,
                });
              } else if (isRetryableProviderError(err)) {
                // A retryable server failure (5xx — e.g. the model emitted an invalid tool
                // call the server rejected) is side-effect-free: no tool ran. Resample once,
                // nudging the model toward valid JSON when the failure looks like a bad call.
                // Only a nudged retry (i.e. we know it's a tool-call problem) is worth
                // constraining — an unrelated 5xx resamples blind, same as before WS4.
                const nudge = toolCallParseNudge(err);
                const retryMessages = nudge ? [...messages, nudge] : messages;
                const envelope = nudge
                  ? this.retryEnvelope(choice.provider, activeToolSchemas)
                  : undefined;
                try {
                  res = await streamWithIdleRetry({
                    sessionId,
                    provider,
                    model: choice.model,
                    messages: retryMessages,
                    toolSchemas: activeToolSchemas,
                    abortSignal,
                    tier: decision.tier,
                    reason: `${decision.reason} (retry-provider)`,
                    responseFormat: envelope,
                  });
                } catch (err2) {
                  if (envelope && isNoResponseFormatError(err2) && !abortSignal.aborted) {
                    this.noResponseFormat.add(choice.provider);
                    this.opts.log.append({
                      sessionId,
                      type: "notice",
                      payload: {
                        text: `${choice.provider} doesn't support structured output — retrying without it.`,
                        level: "warn",
                      },
                    });
                    res = await streamWithIdleRetry({
                      sessionId,
                      provider,
                      model: choice.model,
                      messages: retryMessages,
                      toolSchemas: activeToolSchemas,
                      abortSignal,
                      tier: decision.tier,
                      reason: `${decision.reason} (retry-provider)`,
                    });
                  } else {
                    throw err2;
                  }
                }
              } else {
                throw err;
              }
            }
            // Empty completion (no answer, no tool call) — some models route their output to
            // the reasoning channel (gpt-oss, Qwen/Ollama, etc.). Retry once; smart routing may
            // use its large tier when the small model demonstrably reasoned without a deliverable.
            const isEmpty = (r: typeof res) =>
              r.finishReason !== "tool-calls" &&
              r.finishReason !== "error" && // a server-side error isn't a retryable empty turn
              r.toolCalls.length === 0 &&
              r.textBuf.trim().length === 0;
            if (isEmpty(res) && !abortSignal.aborted) {
              // Count the billed-but-empty first call before `res` is reassigned; the post-block
              // accumulation then counts the retry result, so no usage is dropped (#155 review).
              recordUsage(res.usage);
              // Corrective retry (WS3.2): when the empty turn leaked tool-call markup into the
              // reasoning channel, say what went wrong instead of resampling blind. The nudge
              // exists only in this retry's message array — never in stored history.
              const hasMarkup = reasoningHasToolCallMarkup(res.reasoningBuf);
              const reasonedEmpty = !hasMarkup && res.reasoningBuf.trim().length > 0;
              const strongerRecovery = reasonedEmpty
                ? router.recoverFromReasonedEmpty?.(routeContext, decision)
                : null;
              const unfinished = unfinishedTodoCount(this.latestTodosBySession.get(sessionId));
              const incompleteWorkNudge =
                !hasMarkup && usedTools && unfinished > 0
                  ? prematureStopNudge(unfinished, "empty")
                  : null;
              let retryMessages = hasMarkup
                ? [...messages, REASONING_MARKUP_NUDGE]
                : strongerRecovery
                  ? [
                      ...messages,
                      {
                        role: "system" as const,
                        content:
                          "The small-tier model completed its reasoning without producing an answer or tool call. Complete the user's request now; use the available tools when evidence is needed.",
                      },
                    ]
                  : incompleteWorkNudge
                    ? [...messages, incompleteWorkNudge]
                    : messages;
              // Constrained decoding (WS4) rides only alongside the markup nudge — a pure-empty
              // turn gives no signal that a tool call was even intended, so it stays a blind resample.
              const envelope = hasMarkup
                ? this.retryEnvelope(choice.provider, activeToolSchemas)
                : undefined;
              try {
                if (strongerRecovery) {
                  decision = strongerRecovery;
                  choice = decision.choice;
                  provider = providers.get(choice.provider);
                  messages = await this.assembleMessages(
                    sessionId,
                    history,
                    systemPrompt,
                    provider,
                    choice.model,
                    choice.provider,
                    abortSignal,
                    toolSchemaTokens,
                  );
                  retryMessages = [...messages, retryMessages.at(-1)!];
                  previousRoutedTier = decision.tier;
                  if (decision.lease === "recovery") {
                    if (!routingRecoveryLeaseActive) {
                      routingConsecutiveToolSuccesses = 0;
                    }
                    routingRecoveryLeaseActive = true;
                  }
                  log.append({
                    sessionId,
                    type: "notice",
                    payload: {
                      text: `smart routing: ${choice.model} is recovering a small-tier completion that produced reasoning but no answer or tool call`,
                      level: "info",
                      kind: "route_recovery",
                    },
                  });
                }
                res = await streamWithIdleRetry({
                  sessionId,
                  provider,
                  model: choice.model,
                  messages: retryMessages,
                  toolSchemas: activeToolSchemas,
                  abortSignal,
                  tier: decision.tier,
                  reason: strongerRecovery ? decision.reason : `${decision.reason} (retry-empty)`,
                  responseFormat: envelope,
                });
              } catch (err2) {
                if (envelope && isNoResponseFormatError(err2) && !abortSignal.aborted) {
                  this.noResponseFormat.add(choice.provider);
                  this.opts.log.append({
                    sessionId,
                    type: "notice",
                    payload: {
                      text: `${choice.provider} doesn't support structured output — retrying without it.`,
                      level: "warn",
                    },
                  });
                  res = await streamWithIdleRetry({
                    sessionId,
                    provider,
                    model: choice.model,
                    messages: retryMessages,
                    toolSchemas: activeToolSchemas,
                    abortSignal,
                    tier: decision.tier,
                    reason: `${decision.reason} (retry-empty)`,
                  });
                } else {
                  throw err2;
                }
              }
            }
            textBuf = res.textBuf;
            reasoningText = res.reasoningBuf;
            anyRecovered = res.anyRecovered;
            for (const c of res.toolCalls) pendingToolCalls.push(c);
            finishReason = res.finishReason;
            this.maybeWarnServedModel(sessionId, choice.model, res.servedModel);
            recordUsage(res.usage);
          } catch (e) {
            // Runaway-stream watchdog fired: stop cleanly with a distinct notice (NOT a user cancel).
            if (e instanceof StreamWatchdogError) {
              // A reasoning-cycle / rumination abort means the model got stuck DELIBERATING without
              // acting (oscillating a decision). Once per turn, inject a decisive nudge and retry
              // rather than halting cold — the model that looped usually just needs to be told to
              // decide and act. Idle timeouts have their own bounded retry above. First-token,
              // repetition, and ceiling stops do not get a deliberation retry.
              const deliberationLoop = e.kind === "reasoning_cycle" || e.kind === "rumination";
              if (deliberationLoop && !loopBreakRetried && !abortSignal.aborted) {
                loopBreakRetried = true;
                history.push(loopBreakNudge());
                log.append({
                  sessionId,
                  type: "notice",
                  payload: {
                    text: "The model looped on the same reasoning without acting; nudging it to decide and take one concrete action, then retrying once.",
                    level: "warn",
                    kind: "stream_watchdog_retry",
                  },
                });
                continue;
              }
              const seconds = Math.round(e.limitMs / 1000);
              const text =
                e.kind === "reasoning_cycle"
                  ? "The model got stuck repeating an exact long reasoning cycle and was stopped — it was not making progress. Try a different model or set stream_watchdog.reasoning_cycle_repeats: 0 to disable this check."
                  : e.kind === "rumination"
                    ? "The model got stuck repeating the same reasoning and was stopped — it was not making progress. Try a different model, rephrase the task, or set stream_watchdog.reasoning_loop_lines: 0 to disable this check."
                    : e.kind === "repetition"
                      ? "The model degenerated into repeating output and was stopped — try a different model, a lower temperature, or check your inference-server version. Set stream_watchdog.repetition_repeats: 0 if this was legitimate output."
                      : e.kind === "first_token"
                        ? `The model produced no first token for over ${seconds}s and was stopped (a large model may still be loading). Raise stream_watchdog.first_token_ms or try a lighter model.`
                        : e.kind === "idle"
                          ? `The model produced no output for over ${seconds}s and was stopped (it may be stuck). Raise stream_watchdog.no_progress_ms or try a simpler request.`
                          : `The model streamed for over ${seconds}s without finishing and was stopped (possible runaway loop). Raise stream_watchdog.max_call_ms if this was real work.`;
              log.append({
                sessionId,
                type: "notice",
                payload: { text, level: "warn", kind: "stream_watchdog" },
              });
              const note =
                e.kind === "reasoning_cycle"
                  ? "(stopped: model repeated an exact long reasoning cycle without progressing)"
                  : e.kind === "rumination"
                    ? "(stopped: model looped on the same reasoning without progressing)"
                    : e.kind === "repetition"
                      ? "(stopped: model emitted degenerate repeating output)"
                      : e.kind === "first_token"
                        ? `(stopped: no first token for >${seconds}s — model may still be loading)`
                        : e.kind === "idle"
                          ? `(stopped: no output for >${seconds}s — may be stuck)`
                          : `(stopped: streamed >${seconds}s without finishing — possible runaway)`;
              history.push({ role: "assistant", content: note });
              log.append({
                sessionId,
                type: "assistant_message",
                payload: { text: note, stoppedReason: "stream_watchdog" },
              });
              return {
                assistantText: note,
                toolCalls: toolCallCount,
                successfulToolCalls,
                failedToolCalls,
                unproductiveToolCalls,
                successfulEdits,
                failedWrites,
                stoppedReason: "stream_watchdog",
                editedPaths: [...turnEditedPaths],
                verificationResults: [...verificationResults.values()],
              };
            }
            // User cancelled (Escape): end the turn cleanly rather than as an error. A deadline
            // abort also sets abortSignal.aborted, so reclassify it as time_budget first —
            // otherwise a stalled worker (the mechanism this deadline exists to catch) would be
            // misreported as a user cancel.
            if (abortSignal.aborted) {
              const timedOut = turnDeadline.signal.aborted && !userSignal.aborted;
              const note = timedOut
                ? `Stopped: this task ran for over ${Math.round(deadlineMs / 1000)}s without converging. It did not complete.`
                : "(cancelled)";
              history.push({ role: "assistant", content: note });
              log.append({
                sessionId,
                type: "assistant_message",
                payload: { text: note, stoppedReason: timedOut ? "time_budget" : "cancelled" },
              });
              return {
                assistantText: note,
                toolCalls: toolCallCount,
                successfulToolCalls,
                failedToolCalls,
                unproductiveToolCalls,
                successfulEdits,
                failedWrites,
                editedPaths: [...turnEditedPaths],
                verificationResults: [...verificationResults.values()],
                stoppedReason: timedOut ? "time_budget" : "cancelled",
                progressSummary: progressSummary(),
                budgetExtensions,
              };
            }
            // A retryable server failure that survived the resample: end the turn cleanly
            // with a friendly notice instead of surfacing the raw server error. The
            // technical error is still logged for diagnostics/insights.
            if (isRetryableProviderError(e)) {
              const message = (e as Error).message;
              const toolParse = TOOL_CALL_PARSE_RE.test(message);
              const connectionFailure =
                e instanceof CleetusError && e.code === "PROVIDER_UNREACHABLE";
              log.append({ sessionId, type: "error", payload: { phase: "model", message } });
              const noticeText = toolParse
                ? "The model produced an invalid tool call and a retry didn't help — try rephrasing your request."
                : connectionFailure
                  ? "The model connection was interrupted and a retry didn't help. Completed edits are preserved; try again in a moment."
                  : "The model server failed (5xx) and a retry didn't help — try again in a moment.";
              log.append({
                sessionId,
                type: "notice",
                payload: { text: noticeText, level: "warn" },
              });
              const note = toolParse
                ? "(stopped: the model produced an invalid tool call)"
                : connectionFailure
                  ? "(stopped: the model connection failed repeatedly)"
                  : "(stopped: the model server failed repeatedly)";
              history.push({ role: "assistant", content: note });
              log.append({
                sessionId,
                type: "assistant_message",
                payload: { text: note, stoppedReason: "provider_error" },
              });
              return {
                assistantText: note,
                stoppedReason: "provider_error",
                toolCalls: toolCallCount,
                successfulToolCalls,
                failedToolCalls,
                unproductiveToolCalls,
                successfulEdits,
                failedWrites,
                editedPaths: [...turnEditedPaths],
                verificationResults: [...verificationResults.values()],
              };
            }
            // Fix A: append a terminal assistant message before re-throwing so the next
            // user message doesn't produce a [user, user] sequence.
            log.append({
              sessionId,
              type: "error",
              payload: { phase: "model", message: (e as Error).message },
            });
            history.push({ role: "assistant", content: "" });
            log.append({ sessionId, type: "assistant_message", payload: { text: "" } });
            throw e;
          }
        } catch (e) {
          // Fix B: selector/provider errors reach here; they haven't pushed an assistant
          // message yet, so push one now (same as Fix A path) then re-throw.
          // Only handle if this is NOT the re-throw from the inner model-error catch
          // (that path already pushed and re-throws, reaching here; avoid double-push).
          const lastMsg = history[history.length - 1];
          if (!lastMsg || lastMsg.role !== "assistant") {
            log.append({
              sessionId,
              type: "error",
              payload: { phase: "model", message: (e as Error).message },
            });
            history.push({ role: "assistant", content: "" });
            log.append({ sessionId, type: "assistant_message", payload: { text: "" } });
          }
          throw e;
        }

        assistantText = textBuf;
        if (textBuf.trim() && pendingToolCalls.length > 0) lastNarration = textBuf.trim();

        if (finishReason !== "tool-calls" || pendingToolCalls.length === 0) {
          let finalText = textBuf;
          // Routing correctness: only synthesize with the finish-pass (large) model when the turn
          // actually used tools. A no-tool answer from the gather model is already final — re-running
          // the large model on it is the wasteful speed-mode double-response.
          let finishError: { model: string; message: string } | null = null;
          const finish = usedTools ? router.finishPass() : null;
          if (finish && this.automaticFinishPassAllowed(finish, sessionId)) {
            postProcessingAttempted = true;
            const synthesisMessages = groundedSynthesisMessages({
              systemPrompt,
              request: userInput,
              evidence: currentTurnEvidence(history, turnStartIndex),
              draft: textBuf,
            });
            const r = await this.runFinishPass(
              finish,
              synthesisMessages,
              "",
              abortSignal,
              sessionId,
              false,
            );
            if (abortSignal.aborted) {
              // A deadline abort also sets abortSignal.aborted — reclassify before falling
              // back to the generic user-cancel text (see the model-call-loop cancel branch).
              const timedOut = turnDeadline.signal.aborted && !userSignal.aborted;
              if (timedOut) {
                stoppedReason = "time_budget";
                finalText = `Stopped: this task ran for over ${Math.round(deadlineMs / 1000)}s without converging. It did not complete.`;
              } else {
                stoppedReason = "cancelled";
                finalText = "(cancelled)";
              }
            } else if (r.status === "ok") finalText = r.text;
            else if (r.status === "error")
              finishError = { model: finish.choice.model, message: r.message };
            // r.status === "empty" → leave finalText as the gather model's textBuf (today's fallback)
          }
          // Retain current-turn evidence only as a safety check for an optional personality
          // correction. Automatic grounded-repair synthesis was removed: repeated smoke runs
          // showed that its extra call usually got rejected and sometimes degraded good prose.
          const exactArtifactStillUnverified =
            turnRetrievalKind === "data_artifact" &&
            exactFetchedArtifactRequested &&
            latestFetchedJsonSource !== null &&
            ![...artifactWrittenPaths].some((path) => fidelityValidatedPaths.has(path));
          const synthesisEvidence =
            turnRetrievalKind !== null && usedTools
              ? currentTurnEvidence(history, turnStartIndex)
              : "";
          if (
            exactArtifactStillUnverified &&
            !abortSignal.aborted &&
            !artifactFidelityContinuationRequested
          ) {
            artifactFidelityContinuationRequested = true;
            history.push({ role: "assistant", content: finalText });
            history.push({
              role: "user",
              content: [
                "ARTIFACT COMPLETION REQUIRED: No destination has been verified against the",
                "requested payload. A cached JSON response may be intermediate lookup data, not",
                "the requested artifact. If the latest response is the requested payload, save it",
                "exactly with save_fetched_json. Otherwise continue retrieval until the actual",
                "payload is fetched, then save that response. Do not manually reconstruct it.",
                `Latest cached source URL: ${latestFetchedJsonSource!.url}`,
                `Written destination(s): ${[...artifactWrittenPaths].join(", ") || "(none)"}`,
              ].join(" "),
            });
            if (finalText.trim()) {
              log.append({ sessionId, type: "assistant_message", payload: { text: finalText } });
            }
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: "artifact completion was deferred because no destination was verified against the requested payload",
                level: "warn",
                kind: "artifact_completion_required",
              },
            });
            continue;
          }
          if (exactArtifactStillUnverified && !abortSignal.aborted) {
            stoppedReason = "premature_completion";
            finalText =
              "Stopped: the JSON destination was written, but Cleetus could not verify that it completely matched the fetched source. The artifact may be incomplete.";
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: "artifact fidelity remained unverified after one focused correction",
                level: "warn",
                kind: "artifact_fidelity_exhausted",
              },
            });
          }
          const unfinished = unfinishedTodoCount(this.latestTodosBySession.get(sessionId));
          const premature = prematureImplementationStop({
            text: finalText,
            usedTools,
            unfinishedTodos: unfinished,
          });
          const continuationLimit = premature === "empty" ? 1 : 2;
          if (
            premature &&
            !abortSignal.aborted &&
            !convergenceFinalRequested &&
            prematureStopContinuations < continuationLimit
          ) {
            prematureStopContinuations++;
            history.push({ role: "assistant", content: finalText });
            history.push(prematureStopNudge(unfinished, premature));
            if (finalText.trim()) {
              log.append({ sessionId, type: "assistant_message", payload: { text: finalText } });
            }
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: `The model stopped ${premature === "empty" ? "without responding" : "after only announcing its next action"} while ${unfinished} todo item${unfinished === 1 ? " was" : "s were"} unfinished; asking it to continue.`,
                level: "warn",
                kind: "premature_completion",
              },
            });
            continue;
          }
          if (premature && !abortSignal.aborted && !convergenceFinalRequested) {
            stoppedReason = "premature_completion";
            finalText = `Stopped: the model repeatedly ${premature === "empty" ? "returned an empty response" : "ended after announcing a next action"} while ${unfinished} todo item${unfinished === 1 ? " remains" : "s remain"} unfinished. The implementation did not complete.`;
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: "The model repeatedly stopped before completing its own todo list. Cleetus is preserving the turn as incomplete instead of reporting success.",
                level: "warn",
                kind: "premature_completion_exhausted",
              },
            });
          }
          const directCodingImplementation =
            this.opts.completionAudit === true &&
            (!source || source === "user") &&
            !planNow &&
            successfulEdits > 0 &&
            hasImplementationChanges(editedFileSnapshots.values());
          const auditRegressions = directCodingImplementation
            ? testCoverageRegressions(editedFileSnapshots.values())
            : [];
          const auditWeakTests = directCodingImplementation
            ? testEvidenceWeaknesses(editedFileSnapshots.values())
            : [];
          const renderEvidenceRequired =
            requiresRenderEvidence(userInput) ||
            approvedTodoContract.verification.includes("render");
          const auditUnsupportedClaims = directCodingImplementation
            ? unsupportedCompletionClaims(finalText, [...verificationResults.values()], {
                requiresRenderEvidence: renderEvidenceRequired,
              })
            : [];
          const semanticAuditNeeded =
            directCodingImplementation &&
            shouldRunCompletionAudit({
              taskClass: classifyTask(userInput),
              verificationResults: [...verificationResults.values()],
              regressions: auditRegressions,
              weakTests: auditWeakTests,
              unsupportedClaims: auditUnsupportedClaims,
              requiresRenderEvidence: renderEvidenceRequired,
            });
          if (
            !premature &&
            !abortSignal.aborted &&
            !convergenceFinalRequested &&
            semanticAuditNeeded &&
            !completionAuditRequested
          ) {
            completionAuditRequested = true;
            this.auditCallGates.set(sessionId, () => {
              if (auditLimit) return null; // the bounded tool-less final response reserve
              if (auditModelCalls >= auditLimits.modelCalls) {
                closeAudit(`audit exceeded ${auditLimits.modelCalls} model calls`);
                return `Completion audit incomplete: ${auditLimit}.\n${progressSummary()}`;
              }
              auditModelCalls++;
              return null;
            });
            history.push({ role: "assistant", content: finalText });
            history.push({
              role: "user",
              content: `${acceptanceReminder(originalUserRequests(history))}\n\n${completionAuditReminder(
                {
                  regressions: auditRegressions,
                  weakTests: auditWeakTests,
                  unsupportedClaims: auditUnsupportedClaims,
                  verificationResults: [...verificationResults.values()],
                  changedPaths: [...editedFileSnapshots.keys()],
                  inspectionPaths: [...turnInspectedPaths],
                },
              )}`,
            });
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: "Completion audit: checking the final diff, approved requirements, test integrity, and verification evidence before reporting success.",
                level: "info",
                kind: "completion_audit",
              },
            });
            continue;
          }
          const staleTodoCompletion = claimsCompletionWithUnfinishedTodos({
            text: finalText,
            usedTools,
            unfinishedTodos: unfinished,
          });
          // A list carried from a prior turn can correctly remain open, especially between
          // bounded plan steps. A current-turn todo_write must be reconciled before accepting a
          // terminal response, even when its wording omits a whole-task completion claim.
          const todoReconciliationNeeded =
            unfinished > 0 &&
            !reportsUnfinishedTodoWork(finalText) &&
            (workingTodosWrittenThisTurn || staleTodoCompletion);
          if (
            todoReconciliationNeeded &&
            !abortSignal.aborted &&
            !convergenceFinalRequested &&
            !todoCompletionReconciliationRequested
          ) {
            todoCompletionReconciliationRequested = true;
            todoReconciliationPending = true;
            history.push({ role: "assistant", content: finalText });
            history.push({
              role: "user",
              content: `<system-reminder>Your turn is ending while the working todo list you updated still has ${unfinished} unfinished item${unfinished === 1 ? "" : "s"}. Reconcile the full checklist with todo_write before the final summary. If work remains, retain the accurate unfinished statuses and state the concrete limitation; if it is complete, mark the completed items accurately. Do not leave the tracker stale or merely paraphrase it.</system-reminder>`,
            });
            if (finalText.trim()) {
              log.append({ sessionId, type: "assistant_message", payload: { text: finalText } });
            }
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: `The model ended its turn while ${unfinished} todo item${unfinished === 1 ? " remained" : "s remained"} unfinished in a checklist updated this turn; asking it to reconcile the checklist once.`,
                level: "warn",
                kind: "todo_completion_reconciliation",
              },
            });
            continue;
          }
          // Unresolved limitations to fold into the delivered answer as one appended block, rather
          // than a separate append per source (which would repeat the qualification header).
          const pendingQualifications: string[] = auditLimit
            ? [`Completion audit incomplete: ${auditLimit}. Remaining requirements are unverified.`]
            : [];
          if (
            todoReconciliationNeeded &&
            !abortSignal.aborted &&
            !convergenceFinalRequested &&
            todoCompletionReconciliationRequested
          ) {
            // Deliver-and-qualify: one reconciliation retry did not close the todos, but the built
            // work is real. Keep the model's summary and record the open items as a limitation
            // instead of discarding a buildable result with a hard "did not accept as complete" stop.
            pendingQualifications.push(
              unfinishedTodoQualification(this.latestTodosBySession.get(sessionId)),
            );
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: `The model did not reconcile ${unfinished} unfinished todo item${unfinished === 1 ? "" : "s"} after one focused retry; delivering the work with the open items recorded as a limitation.`,
                level: "warn",
                kind: "todo_completion_reconciliation_exhausted",
              },
            });
          }
          if (
            visibilityComplaint &&
            ![...verificationResults.values()].some((check) => check.ok && check.control)
          ) {
            pendingQualifications.push(
              "The reported control visibility was not verified; DOM presence and passing unit tests do not resolve this report.",
            );
          }
          if (completionAuditRequested && !completionEvidenceWarningEmitted) {
            const regressions = testCoverageRegressions(editedFileSnapshots.values());
            const weakTests = testEvidenceWeaknesses(editedFileSnapshots.values());
            const unsupportedClaims = unsupportedCompletionClaims(
              finalText,
              [...verificationResults.values()],
              { requiresRenderEvidence: renderEvidenceRequired },
            );
            if (regressions.length > 0 || weakTests.length > 0 || unsupportedClaims.length > 0) {
              completionEvidenceWarningEmitted = true;
              const details = [
                ...regressions.map(
                  (item) =>
                    `${item.path} reduced tests ${item.testsBefore}->${item.testsAfter} or assertions ${item.assertionsBefore}->${item.assertionsAfter}`,
                ),
                ...weakTests.map((item) => `${item.path}: ${item.reason}`),
                ...unsupportedClaims,
              ];
              pendingQualifications.push(...details);
              log.append({
                sessionId,
                type: "notice",
                payload: {
                  text: `Completion evidence remains qualified: ${details.join("; ")}`,
                  level: "warn",
                  kind: "completion_evidence",
                },
              });
            }
          }
          // A verification/test check that would not converge was recorded rather than discarding
          // the built work; surface it as an explicit unresolved limitation on the delivered result.
          if (thrashVerificationLimit) {
            pendingQualifications.push(
              `the check \`${thrashVerificationLimit}\` did not pass after repeated attempts and remains unresolved; the rest of the implementation was delivered — fix or remove that check before relying on the suite`,
            );
          }
          if (pendingQualifications.length > 0) {
            finalText = appendCompletionEvidenceQualification(finalText, pendingQualifications);
          }
          const voiceCorrection =
            !stoppedReason && !abortSignal.aborted && !postProcessingAttempted
              ? this.opts.voiceCorrection?.(finalText)
              : null;
          if (voiceCorrection) {
            const voiceDecision = finish ?? routedDecision;
            if (voiceDecision && this.automaticFinishPassAllowed(voiceDecision, sessionId, 1024)) {
              postProcessingAttempted = true;
              const corrected = await this.runFinishPass(
                {
                  ...voiceDecision,
                  reason: `finish: personality-correction (${voiceDecision.reason})`,
                },
                [{ role: "user", content: voiceCorrection.instruction }],
                voiceCorrection.systemPrompt,
                abortSignal,
                sessionId,
                false,
                "low",
                1024,
              );
              if (
                corrected.status === "ok" &&
                (!voiceCorrection.accept || voiceCorrection.accept(corrected.text)) &&
                (!synthesisEvidence ||
                  synthesisGroundingIssues(userInput, corrected.text, synthesisEvidence).length <=
                    synthesisGroundingIssues(userInput, finalText, synthesisEvidence).length)
              ) {
                finalText = corrected.text;
                log.append({
                  sessionId,
                  type: "notice",
                  payload: {
                    text: "active personality was missing from the draft; applied one bounded prose-only correction pass",
                    level: "info",
                    kind: "personality_correction",
                    visibility: "verbose",
                  },
                });
              } else if (corrected.status === "ok") {
                log.append({
                  sessionId,
                  type: "notice",
                  payload: {
                    text: "discarded personality correction because it failed the requested voice or protected-content checks",
                    level: "warn",
                    kind: "personality_correction_rejected",
                    visibility: "verbose",
                  },
                });
              }
            }
          }
          // Option A: a finish-pass provider error overrides the empty-turn classification only when
          // there is no fallback answer — otherwise the gather answer stands with no scary notice.
          const turnNotice =
            finishError && finalText.trim().length === 0
              ? finishPassErrorNotice(finishError.model, finishError.message)
              : selectTurnEndNotice({
                  finishReason,
                  finalText,
                  reasoning: reasoningText,
                  aborted: abortSignal.aborted,
                });
          if (turnNotice) {
            log.append({
              sessionId,
              type: "notice",
              payload: { text: turnNotice.text, level: "warn", kind: turnNotice.kind },
            });
          }
          history.push({ role: "assistant", content: finalText });
          log.append({
            sessionId,
            type: "assistant_message",
            payload: { text: finalText, ...(stoppedReason ? { stoppedReason } : {}) },
          });
          assistantText = finalText;
          completedNormally = true;
          break;
        }

        // This iteration returned tool calls (the finish block above did not break): the turn is
        // doing real tool work, so the speed finish pass is warranted.
        usedTools = true;

        history.push({
          role: "assistant",
          content: anyRecovered ? stripToolCallMarkup(textBuf) : textBuf,
          toolCalls: pendingToolCalls,
          reasoning: reasoningText || undefined,
        });

        // Surface this tool-using step's narration. Previously only the final step logged
        // an assistant_message, so per-step intent was dropped from the transcript and the
        // event log. Guarded on non-empty prose so tool-only steps add no empty block.
        if (textBuf.trim().length > 0) {
          log.append({ sessionId, type: "assistant_message", payload: { text: textBuf } });
        }

        // Some local/compat providers still emit recovered tool calls after schemas have been
        // removed for the evidence-budget final response. Do not execute them: one correction gets
        // a matched tool result and a forced tool-less retry; a second ends the attempt promptly
        // instead of burning hundreds of thousands of tokens on malformed calls (glm-orch1).
        if (convergenceFinalRequested || artifactFinalSynthesisRequested) {
          for (const call of pendingToolCalls) {
            history.push({
              role: "tool",
              toolCallId: call.id,
              content:
                "Tool access is closed for the final response. Return the required answer now using existing evidence; do not call another tool.",
            });
          }
          convergenceToolViolations++;
          if (convergenceToolViolations >= 2) {
            hiddenStop = true;
            break;
          }
          log.append({
            sessionId,
            type: "notice",
            payload: {
              text: artifactFinalSynthesisRequested
                ? "model attempted a tool after artifact validation; forced one final tool-less response"
                : source === "orchestration-worker"
                  ? "worker attempted a tool after its evidence budget closed; forced one final tool-less response"
                  : "model attempted another tool after post-verification convergence; forced one final tool-less response",
              level: "warn",
            },
          });
          continue;
        }

        // Fix D: per-tool-call body is wrapped so resolvePermission throws don't leave
        // unmatched tool calls in history. If it throws, we add an error result for
        // every unresolved call and break out with a terminal assistant message.
        let permissionThrew = false;
        const resolvedCallIds = new Set<string>();
        // Diagnostics are coalesced to one batch per step: collect the step's edited paths
        // and a handle to the LAST file-mutating tool result, then run one check after the loop.
        const editedPaths: string[] = [];
        let lastEditEntry: { content: string } | null = null;
        let lastToolEntry: { content: string } | null = null;
        let lastEditCallId: string | null = null;
        const isSingleInspectionRound =
          pendingToolCalls.length === 1 &&
          isBatchableInspectionCall(pendingToolCalls[0]?.name ?? "", pendingToolCalls[0]?.args);
        singleInspectionRoundStreak = isSingleInspectionRound ? singleInspectionRoundStreak + 1 : 0;
        for (const call of pendingToolCalls) {
          toolCallCount++;
          // Recover the observed wrong-tool choice only during the explicit working-list
          // reconciliation, and only for exactly the same ordered tasks. Ordinary named-list
          // operations remain independent. Run the real todo_write validation, evidence guard,
          // permission path, and event emission so persistence and every UI see the same update.
          const workingTodos = this.latestTodosBySession.get(sessionId) ?? [];
          const proposed = (call.args as { todos?: unknown } | null)?.todos;
          if (
            todoReconciliationPending &&
            call.name === "todo_list_write" &&
            tools.get("todo_write") &&
            workingTodos.length > 0 &&
            Array.isArray(proposed) &&
            proposed.length === workingTodos.length &&
            proposed.every((todo, index) => todo?.content === workingTodos[index]!.content)
          ) {
            call.name = "todo_write";
            call.args = { todos: proposed };
            log.append({
              sessionId,
              type: "notice",
              payload: {
                kind: "todo_tool_recovery",
                level: "info",
                text: "Recovered a named-list update as todo_write while reconciling the same working checklist.",
              },
            });
          }
          if (convergenceFinalRequested && !completionAuditRequested) {
            history.push({
              role: "tool",
              toolCallId: call.id,
              content:
                "Tool access is closed after repeated unchanged verification. Finalize using the existing evidence.",
            });
            resolvedCallIds.add(call.id);
            continue;
          }
          if (completionAuditRequested) {
            auditToolAttempts++;
            const writing = ["write_file", "edit_file", "multi_edit", "apply_patch"].includes(
              call.name,
            );
            if (auditToolAttempts > auditLimits.toolAttempts || (writing && auditRepairVerified)) {
              closeAudit(
                writing && auditRepairVerified
                  ? "a second repair cycle was requested after the audit repair passed verification"
                  : `audit exceeded ${auditLimits.toolAttempts} tool attempts`,
              );
            }
            if (auditLimit) {
              history.push({
                role: "tool",
                toolCallId: call.id,
                content: `error: ${auditLimit}; finalize with remaining requirements unverified`,
              });
              resolvedCallIds.add(call.id);
              continue;
            }
          }
          if (
            visibilityComplaint &&
            call.name === "render_check" &&
            !(call.args as { expectedControl?: string })?.expectedControl &&
            !(call.args as { command?: string })?.command
          ) {
            history.push({
              role: "tool",
              toolCallId: call.id,
              content:
                "error: this visibility report requires expectedControl (the affected control name or placeholder) plus expectedText (the page heading). A text-only render cannot establish control visibility.",
            });
            resolvedCallIds.add(call.id);
            continue;
          }
          const tool = tools.get(call.name);
          if (!tool) {
            // Unknown / hallucinated tool name (incl. an empty name): reject BEFORE the permission
            // prompt — the user should never be asked to approve a tool that does not exist (it would
            // render "<name>(?)"). List the real tools so the model can correct in one shot instead of
            // re-guessing (observed: print_tree ×3, ls ×2 across gpt-oss/qwen).
            const available = toolSchemas
              .map((t) => t.name)
              .sort()
              .join(", ");
            const msg = `no tool named '${call.name}'. Available tools: ${available}`;
            log.append({ sessionId, type: "error", payload: { phase: "tool_args", message: msg } });
            history.push({ role: "tool", toolCallId: call.id, content: `error: ${msg}` });
            recordRoutingToolOutcome(false);
            resolvedCallIds.add(call.id);
            continue;
          }
          const hiddenMsg =
            exactFetchedArtifactRequested && !EXACT_ARTIFACT_TOOL_ROSTER.has(call.name)
              ? `${call.name} is not available for exact retrieved artifacts; use web_search/web_fetch and save_fetched_json so the cached payload is preserved without ad hoc network requests or manual reconstruction.`
              : hiddenToolRedirect(call.name, turnCapability, taskCapabilityTools);
          if (hiddenMsg) {
            log.append({
              sessionId,
              type: "error",
              payload: { phase: "tool_unavailable", message: hiddenMsg },
            });
            let hiddenContent = `error: ${hiddenMsg}`;
            // WS5 N3: hidden-tool hammering is a loop like any other — each repeat costs a
            // full model round-trip. Record it; warn at threshold; abort the turn at 2x
            // (all sources, unlike thrash: these calls are futile in ANY session).
            const lgCfgHidden = this.opts.loopGuard?.();
            if (lgCfgHidden?.enabled) {
              let guard = this.loopGuardBySession.get(sessionId);
              if (!guard) {
                guard = new LoopGuard(lgCfgHidden, projectDir);
                this.loopGuardBySession.set(sessionId, guard);
              }
              const warning = guard.observe(
                { name: call.name, args: call.args },
                { ok: false, hiddenTool: true },
              );
              if (warning) {
                hiddenContent = `${hiddenContent}\n\n${warning}`;
                log.append({
                  sessionId,
                  type: "notice",
                  payload: {
                    text: `loop guard: warned on unavailable tool ${call.name}`,
                    level: "warn",
                    kind: "loop_guard",
                  },
                });
              }
              // hiddenRepeats() is capped at windowSize (it counts hits in a fixed-size ring
              // buffer), so when 2x the threshold exceeds windowSize the raw "2x" trigger can
              // never fire. Saturate it at windowSize instead: a window fully packed with hidden
              // rejections is unambiguous futility even when 2x the threshold overshoots it.
              if (
                guard.hiddenRepeats() >=
                Math.min(2 * lgCfgHidden.hiddenRepeatThreshold, lgCfgHidden.windowSize)
              ) {
                hiddenStop = true;
              }
            }
            history.push({ role: "tool", toolCallId: call.id, content: hiddenContent });
            recordRoutingToolOutcome(false);
            resolvedCallIds.add(call.id);
            // Unlike thrash (worker-only turns whose history is discarded on replan), this
            // abort can fire on interactive/one-shot turns whose history PERSISTS to the next
            // request. Do NOT break mid-batch: a dangling tool_calls id (a call in this
            // assistant message with no matching tool-role result) gets replayed next turn and
            // strict backends (vLLM, template-validating servers) reject the whole request. So
            // always drain the rest of this batch — remaining hidden siblings get their
            // rejection results, real siblings still execute — so every call id in the batch is
            // resolved by the time we fall through to `if (thrashStop || hiddenStop) break;`
            // below, which ends the turn after the batch is fully drained.
            continue;
          }
          const argErr = validateToolArgs(tool, call.args);
          if (argErr) {
            log.append({
              sessionId,
              type: "error",
              payload: { phase: "tool_args", message: argErr },
            });
            history.push({ role: "tool", toolCallId: call.id, content: `error: ${argErr}` });
            recordRoutingToolOutcome(false);
            resolvedCallIds.add(call.id);
            continue;
          }
          if (call.name === "todo_write") {
            const proposed = (call.args as { todos?: unknown } | null)?.todos;
            const proposedTodos = Array.isArray(proposed) ? (proposed as TodoItem[]) : [];
            const allCompleted =
              proposedTodos.length > 0 &&
              proposedTodos.every((todo) => todo?.status === "completed");
            if (
              allCompleted &&
              (approvedTodoContract.expectedFiles.length > 0 ||
                approvedTodoContract.verification.length > 0)
            ) {
              const missingFiles = await missingExpectedFiles(
                approvedTodoContract.expectedFiles,
                projectDir,
              );
              const missingChecks = missingVerificationEvidence(approvedTodoContract.verification, [
                ...verificationResults.values(),
              ]);
              if (missingFiles.length > 0 || missingChecks.length > 0) {
                const evidence = [
                  ...(missingFiles.length > 0
                    ? [`missing promised files: ${missingFiles.join(", ")}`]
                    : []),
                  ...(missingChecks.length > 0
                    ? [`missing successful verification evidence: ${missingChecks.join(", ")}`]
                    : []),
                ].join("; ");
                const msg = `Cannot mark the seeded plan fully complete yet (${evidence}). Update the full todo list honestly, leaving the affected step pending or in_progress, then finish the missing work or report the concrete external blocker.`;
                log.append({
                  sessionId,
                  type: "notice",
                  payload: {
                    text: "tracker completion guard: rejected an unsupported bulk-complete update",
                    level: "warn",
                    kind: "todo_completion_evidence_guard",
                  },
                });
                history.push({ role: "tool", toolCallId: call.id, content: `error: ${msg}` });
                recordRoutingToolOutcome(false);
                resolvedCallIds.add(call.id);
                continue;
              }
            }
          }
          if (identifierResolutionSearchEligibleLoop === loop && call.name !== "web_search") {
            identifierResolutionSearchEligibleLoop = null;
            identifierResolutionSearchCreditAvailable = false;
          }
          const crossProject = await unexpectedCleetusProjectReference(
            call.name,
            call.args,
            projectDir,
            userInput,
          );
          if (crossProject) {
            const msg = `Unexpected cross-project path '${crossProject.rawPath}'. This turn is rooted at '${projectDir}'; use paths inside it. Access another Cleetus project only when the user explicitly names it.`;
            log.append({
              sessionId,
              type: "error",
              payload: {
                phase: "cross_project_path",
                message: msg,
                projectRoot: crossProject.projectRoot,
              },
            });
            history.push({ role: "tool", toolCallId: call.id, content: `error: ${msg}` });
            recordRoutingToolOutcome(false);
            resolvedCallIds.add(call.id);
            continue;
          }
          const ungroundedArtifactSave =
            turnRetrievalKind === "data_artifact" &&
            exactFetchedArtifactRequested &&
            latestFetchedJsonSource &&
            !latestFetchedJsonSource.identityGrounded &&
            call.name === "save_fetched_json" &&
            (call.args as { url?: unknown } | undefined)?.url === latestFetchedJsonSource.url;
          if (ungroundedArtifactSave && latestFetchedJsonSource) {
            const msg = `The cached JSON from ${latestFetchedJsonSource.url} has not been tied to the requested entity by retrieved evidence. Do not save it. Resolve an identity-bearing source URL, evidence-backed coordinates, or an endpoint returned by a successful lookup; fetch the correct payload, then save it with save_fetched_json.`;
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: "artifact identity guard: blocked an ungrounded cached save; retrieval remains available",
                level: "warn",
                kind: "artifact_identity_guard",
              },
            });
            history.push({ role: "tool", toolCallId: call.id, content: `error: ${msg}` });
            recordRoutingToolOutcome(false);
            resolvedCallIds.add(call.id);
            continue;
          }
          const lossyArtifactWrite =
            turnRetrievalKind === "data_artifact" &&
            exactFetchedArtifactRequested &&
            latestFetchedJsonSource &&
            call.name !== "save_fetched_json" &&
            (PATH_WRITING_TOOLS.has(call.name) ||
              downloadRequest(call.name, call.args)?.writesFile === true);
          if (lossyArtifactWrite && latestFetchedJsonSource) {
            const msg = latestFetchedJsonSource.identityGrounded
              ? `Do not manually reconstruct an exact retrieved artifact. If ${latestFetchedJsonSource.url} is the requested payload, save it with save_fetched_json. If it is only intermediate lookup data, continue retrieval until the actual payload is fetched.`
              : `The cached JSON from ${latestFetchedJsonSource.url} has not been tied to the requested entity by retrieved evidence. Do not save it. Resolve an identity-bearing source URL, evidence-backed coordinates, or an endpoint returned by a successful lookup; fetch the correct payload, then save it with save_fetched_json.`;
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: `exact artifact guard: blocked lossy ${call.name}; retrieval remains available`,
                level: "warn",
                kind: latestFetchedJsonSource.identityGrounded
                  ? "artifact_lossy_write_guard"
                  : "artifact_identity_guard",
              },
            });
            history.push({ role: "tool", toolCallId: call.id, content: `error: ${msg}` });
            recordRoutingToolOutcome(false);
            resolvedCallIds.add(call.id);
            continue;
          }
          if (this.opts.malformedPath?.().enabled) {
            const hit = await detectMalformedToolPath(call.name, call.args, projectDir);
            if (hit) {
              const raw = extractGuardedPath(call.name, call.args);
              const msg = `malformed path '${raw}' — did you mean '${hit.suggestion}'? Use a path relative to the working directory.`;
              log.append({
                sessionId,
                type: "error",
                payload: { phase: "tool_path", message: msg },
              });
              history.push({ role: "tool", toolCallId: call.id, content: `error: ${msg}` });
              recordRoutingToolOutcome(false);
              resolvedCallIds.add(call.id);
              continue;
            }
          }
          const urlCoordinatesGrounded = retrievalUrlCoordinatesGrounded(
            call.name,
            call.args,
            userInput,
            retrievalIdentifierEvidence,
          );
          const ungroundedCoordinates = ungroundedRetrievalCoordinateBlock(
            turnRetrievalKind,
            call.name,
            call.args,
            userInput,
            retrievalIdentifierEvidence,
          );
          if (ungroundedCoordinates) {
            if (identifierResolutionSearchCreditAvailable) {
              identifierResolutionSearchEligibleLoop = loop + 1;
            }
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: "retrieval guard: blocked a coordinate-bearing fetch whose location identifier had no retrieved provenance",
                level: "warn",
                kind: "ungrounded_retrieval_identifier",
              },
            });
            history.push({
              role: "tool",
              toolCallId: call.id,
              content: `error: ${ungroundedCoordinates}`,
            });
            recordRoutingToolOutcome(false);
            resolvedCallIds.add(call.id);
            continue;
          }
          if (this.opts.planMode?.() && isMutating(tool)) {
            const msg = planModeDenial(call.name);
            log.append({
              sessionId,
              type: "notice",
              payload: { text: `plan mode: blocked ${call.name}`, level: "warn" },
            });
            history.push({ role: "tool", toolCallId: call.id, content: `error: ${msg}` });
            resolvedCallIds.add(call.id);
            planBlockedStreak++;
            const fpThreshold = this.opts.planModeGuard?.().forcePlanAfterBlocks ?? 0;
            if (fpThreshold > 0 && planBlockedStreak >= fpThreshold && !forcePlanSynthesis) {
              forcePlanSynthesis = true;
              log.append({
                sessionId,
                type: "notice",
                payload: {
                  text: `plan mode: producing a plan after ${planBlockedStreak} consecutive blocked tool attempts`,
                  level: "warn",
                },
              });
            }
            continue;
          }
          const summary = tool.serialize(call.args);
          const inspectionPath = completionAuditInspectionPath(call.name, call.args, projectDir);
          const hasPassingCurrentVerification = [...verificationResults.values()].some(
            (result) => result.ok && !result.baseline,
          );
          if (
            !completionAuditRequested &&
            successfulEdits > 0 &&
            hasPassingCurrentVerification &&
            inspectionPath &&
            postVerificationInspectedPaths.has(inspectionPath)
          ) {
            // Block the redundant re-inspection, but do NOT close tool access on the first repeat:
            // re-reading a file to locate the exact spot before applying a fix is normal, and a
            // passing build does not mean a reported runtime bug is fixed. Editing is still allowed
            // (an edit clears this state); only sustained re-reading with no intervening edit closes
            // access, so a genuine no-progress diagnosis loop still terminates.
            postVerificationInspectionBlocks++;
            const closeAccess = postVerificationInspectionBlocks >= 2;
            const message = closeAccess
              ? "You keep re-inspecting files a passing check already covered without making a change. Return the final result now; qualify any remaining runtime limitation instead of rereading it again."
              : "You already inspected this file since the last passing check. If a change is still needed, make the edit now; otherwise finalize. Do not re-read it again first.";
            if (closeAccess) convergenceFinalRequested = true;
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: closeAccess
                  ? `post-verification convergence: blocked repeated ${summary} and closed tool access`
                  : `post-verification convergence: blocked redundant ${summary}; editing remains open`,
                level: "warn",
                kind: "post_verification_convergence",
              },
            });
            history.push({ role: "tool", toolCallId: call.id, content: `error: ${message}` });
            recordRoutingToolOutcome(false);
            resolvedCallIds.add(call.id);
            continue;
          }
          log.append({
            sessionId,
            type: "permission_request",
            payload: { toolCallId: call.id, tool: call.name, summary },
          });

          let decision: Decision;
          pauseDeadline();
          try {
            decision = await resolvePermission({
              toolCallId: call.id,
              tool: call.name,
              args: call.args,
              argsSummary: summary,
            });
          } catch (e) {
            // Fix D: resolvePermission threw — log the error, push an error tool result so
            // the tool call has a matching result, then break out of the tool loop.
            log.append({
              sessionId,
              type: "error",
              payload: { phase: "permission", message: (e as Error).message },
            });
            history.push({
              role: "tool",
              toolCallId: call.id,
              content: "error: permission resolution failed",
            });
            resolvedCallIds.add(call.id);
            permissionThrew = true;
            break;
          } finally {
            armDeadline();
          }

          // Fix E: resolvePermission is expected to return "allow" or "deny".
          // If it somehow returns "ask" (not fully resolved), coerce to "deny" defensively.
          if ((decision as string) === "ask") {
            decision = "deny";
          }

          log.append({
            sessionId,
            type: "permission_decision",
            payload: { tool: call.name, decision },
          });
          // PreToolUse hooks gate an already-allowed tool (they tighten, never loosen). A hook
          // error/timeout fails closed (block). Note: a Ctrl-C mid-hook surfaces as a non-zero exit
          // → spurious block, but that's harmless — the next provider request sees the aborted signal
          // and tears the turn down cleanly, so the injected error never reaches the model.
          if (decision === "allow" && this.opts.hooks) {
            let blockReason: string | null = null;
            try {
              const pre = await this.opts.hooks.runPreToolUse({
                sessionId,
                tool: call.name,
                args: call.args,
                summary,
                signal: abortSignal,
              });
              if (!pre.allow) blockReason = pre.reason ?? "denied";
            } catch {
              blockReason = "hook engine error"; // contained: fail closed
            }
            if (blockReason !== null) {
              log.append({
                sessionId,
                type: "notice",
                payload: { text: `hook: blocked ${call.name}`, level: "warn" },
              });
              history.push({
                role: "tool",
                toolCallId: call.id,
                content: `error: blocked by hook: ${blockReason}`,
              });
              resolvedCallIds.add(call.id);
              continue;
            }
          }
          const lgCfgPre = this.opts.loopGuard?.();
          if (lgCfgPre?.enabled) {
            let guard = this.loopGuardBySession.get(sessionId);
            if (!guard) {
              guard = new LoopGuard(lgCfgPre, projectDir);
              this.loopGuardBySession.set(sessionId, guard);
            }
            const block = guard.gate({ name: call.name, args: call.args });
            if (block) {
              log.append({
                sessionId,
                type: "notice",
                payload: {
                  text: `loop guard: blocked repeated ${call.name} (${summary})`,
                  level: "warn",
                  kind: "loop_guard",
                },
              });
              history.push({ role: "tool", toolCallId: call.id, content: block });
              recordRoutingToolOutcome(false);
              resolvedCallIds.add(call.id);
              continue;
            }
          }
          const rawWritePath = rawToolPath(call.name, call.args);
          const smokeInstallBlock = smokeInfrastructureInstallBlock(
            call.name,
            call.args,
            smokeAttempted,
          );
          if (smokeInstallBlock) {
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: `verification guard: blocked ${summary}; smoke verification must not add disposable server dependencies`,
                level: "warn",
                kind: "verification_guard",
              },
            });
            history.push({
              role: "tool",
              toolCallId: call.id,
              content: `error: ${smokeInstallBlock}`,
            });
            resolvedCallIds.add(call.id);
            continue;
          }
          const redundantJsonDownload =
            turnRetrievalKind === "data_artifact"
              ? redundantFetchedJsonDownloadBlock(
                  call.name,
                  call.args,
                  fetchedJsonUrls,
                  fullyVisibleFetchedJsonUrls,
                  directlyDownloadedJsonUrls,
                )
              : null;
          if (redundantJsonDownload) {
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: `efficiency guard: blocked ${summary}; reuse the successful web_fetch result`,
                level: "info",
                kind: "retrieval_efficiency_guard",
              },
            });
            history.push({
              role: "tool",
              toolCallId: call.id,
              content: `error: ${redundantJsonDownload}`,
            });
            resolvedCallIds.add(call.id);
            continue;
          }
          const hasCurrentHealthySmoke = [...verificationResults.values()].some(
            (verification) =>
              verification.ok &&
              verification.key.startsWith("smoke_run:") &&
              (verification.evidence === "launch" || verification.evidence === "render"),
          );
          // When the user is reporting that the built app is broken at runtime, the model needs to
          // inspect the running server to diagnose (the passing smoke is exactly what it must look
          // past). Do not block its localhost probes on such a turn; the probe guard exists to stop a
          // success-claiming turn from faking render evidence, not to prevent debugging.
          const redundantProbeBlock =
            hasCurrentHealthySmoke && !reportsRuntimeDefect(userInput)
              ? completionAuditToolBlock(call.name, call.args)
              : null;
          if (redundantProbeBlock) {
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: `verification guard: blocked ${summary}; current launch evidence already exists and ad-hoc shell probing would not prove rendering`,
                level: "warn",
                kind: "verification_guard",
              },
            });
            history.push({
              role: "tool",
              toolCallId: call.id,
              content: `error: ${redundantProbeBlock}`,
            });
            resolvedCallIds.add(call.id);
            continue;
          }
          if (completionAuditRequested) {
            const auditPaths = new Set([...editedFileSnapshots.keys(), ...turnInspectedPaths]);
            const scopeBlock = completionAuditScopeBlock(
              call.name,
              call.args,
              projectDir,
              auditPaths,
            );
            if (scopeBlock) {
              log.append({
                sessionId,
                type: "notice",
                payload: {
                  text: `completion audit: blocked out-of-scope ${summary}`,
                  level: "warn",
                  kind: "completion_audit_scope_guard",
                },
              });
              history.push({ role: "tool", toolCallId: call.id, content: `error: ${scopeBlock}` });
              recordRoutingToolOutcome(false);
              resolvedCallIds.add(call.id);
              continue;
            }
            const isNewPath = rawWritePath
              ? !(await pathExistsNonEmpty(resolve(projectDir, rawWritePath)))
              : false;
            const auditBlock = completionAuditToolBlock(call.name, call.args, {
              isNewPath,
              hasPassingVerification: [...verificationResults.values()].some((result) => result.ok),
            });
            if (auditBlock) {
              log.append({
                sessionId,
                type: "notice",
                payload: {
                  text: `completion audit: blocked ${summary}; use existing evidence or the dedicated verification tool`,
                  level: "warn",
                  kind: "completion_audit_guard",
                },
              });
              history.push({
                role: "tool",
                toolCallId: call.id,
                content: `error: ${auditBlock}`,
              });
              resolvedCallIds.add(call.id);
              continue;
            }
          }
          if (rawWritePath) {
            const controlRelative = relative(projectDir, resolve(projectDir, rawWritePath));
            if (protectedControlPath(controlRelative)) {
              log.append({
                sessionId,
                type: "notice",
                payload: {
                  text: `safety guard: blocked control-metadata mutation (${controlRelative})`,
                  level: "warn",
                  kind: "scope_guard",
                },
              });
              history.push({
                role: "tool",
                toolCallId: call.id,
                content: protectedControlPathMessage(controlRelative),
              });
              resolvedCallIds.add(call.id);
              continue;
            }
          }
          if (source === "orchestration-worker") {
            const ownedPaths = this.opts.workerOwnedPaths?.() ?? [];
            const pathArg = ["write_file", "save_fetched_json", "edit_file", "multi_edit"].includes(
              call.name,
            )
              ? (call.args as { path?: unknown }).path
              : undefined;
            const relativePath =
              typeof pathArg === "string" && pathArg.length > 0
                ? relative(projectDir, resolve(projectDir, pathArg))
                : undefined;
            const command =
              call.name === "bash" ? (call.args as { command?: unknown }).command : undefined;
            const blockedPath =
              relativePath !== undefined &&
              protectedInfrastructureBlock({ path: relativePath, ownedPaths });
            const blockedCommand =
              typeof command === "string" && protectedPackageCommandBlock({ command, ownedPaths });
            if (blockedPath || blockedCommand) {
              const target = blockedPath ? relativePath! : "package.json / bun.lock";
              log.append({
                sessionId,
                type: "notice",
                payload: {
                  text: `scope guard: blocked out-of-task infrastructure mutation (${target})`,
                  level: "warn",
                  kind: "scope_guard",
                },
              });
              history.push({
                role: "tool",
                toolCallId: call.id,
                content: protectedScopeBlockMessage(target, title ?? "the current task"),
              });
              resolvedCallIds.add(call.id);
              continue;
            }
          }
          if ((protectExisting || guardPendingScope) && call.name === "write_file") {
            const pathArg = (call.args as { path?: unknown }).path;
            if (typeof pathArg === "string" && pathArg.length > 0) {
              const resolved = resolve(projectDir, pathArg);
              const touched = this.touchedPathsForSession(sessionId).has(resolved);
              const existsNonEmpty = await pathExistsNonEmpty(resolved);
              if (
                protectExisting &&
                blocksRecreate({ toolName: call.name, existsNonEmpty, touched })
              ) {
                log.append({
                  sessionId,
                  type: "notice",
                  payload: {
                    text: `recreate guard: blocked write_file over existing ${summary}`,
                    level: "warn",
                    kind: "recreate_guard",
                  },
                });
                history.push({
                  role: "tool",
                  toolCallId: call.id,
                  content: recreateBlockMessage(pathArg),
                });
                resolvedCallIds.add(call.id);
                continue;
              }
              if (guardPendingScope && !existsNonEmpty) {
                const decision = scopeCreepBlock({
                  path: relative(projectDir, resolved),
                  currentTitle: title ?? "",
                  pendingTitles: this.opts.pendingTaskTitles?.() ?? [],
                });
                if (decision.blocked) {
                  log.append({
                    sessionId,
                    type: "notice",
                    payload: {
                      text: `scope guard: blocked write_file of ${summary} (belongs to "${decision.matchedTitle}")`,
                      level: "warn",
                      kind: "scope_guard",
                    },
                  });
                  history.push({
                    role: "tool",
                    toolCallId: call.id,
                    content: scopeBlockMessage(pathArg, decision.matchedTitle!, title ?? ""),
                  });
                  resolvedCallIds.add(call.id);
                  continue;
                }
              }
            }
          }
          const verificationKey = verificationCommandKey(call.name, call.args);
          const maskedVerification = verificationCommandMasksExit(call.name, call.args);
          const setupActionKey = repeatableSetupCommandKey(call.name, call.args);
          const cachedSetupAction = setupActionKey
            ? successfulSetupActions.get(setupActionKey)
            : undefined;
          const replayContext = verificationReplayContext(call.name, call.args);
          // Shell changes have no ToolResult.diff, including partial writes before a failure.
          // Invalidate replay before dispatch so a compound cleanup/build actually executes.
          if (
            call.name === "bash" &&
            !(verificationKey && replayContext !== null) &&
            !isBatchableInspectionCall(call.name, call.args) &&
            !cachedSetupAction
          ) {
            verificationEpochs.clear();
            verificationReplayContexts.clear();
          }
          const cachedVerificationCandidate =
            verificationKey &&
            replayContext !== null &&
            verificationReplayContexts.get(verificationKey) === replayContext &&
            !maskedVerification &&
            verificationEpochs.get(verificationKey) === trackedEditEpoch
              ? verificationResults.get(verificationKey)
              : undefined;
          // Only replay a PASSING verification. A previously-failed check must always re-run: the
          // model may have fixed it through an environmental change (setting GOCACHE, creating an
          // untracked config file, installing a dependency) that is not a tracked-file edit, so the
          // epoch guard alone would replay the stale failure and make the fix invisible — the loop
          // that drowned a model fighting a Go build-cache sandbox denial.
          const cachedVerification = cachedVerificationCandidate?.ok
            ? cachedVerificationCandidate
            : undefined;
          let repeatedVerificationReminder: string | null = null;
          if (cachedVerification && verificationKey) {
            const repeatKey = `${trackedEditEpoch}:${verificationKey}`;
            const repeats = (repeatedVerificationRequests.get(repeatKey) ?? 0) + 1;
            repeatedVerificationRequests.set(repeatKey, repeats);
            if (repeats >= 3) {
              if (completionAuditRequested)
                closeAudit("repeated requests for unchanged passing verification");
              else {
                // A passing focused check does not complete the task. The cache already
                // suppresses redundant execution; closing every tool here strands later
                // implementation steps and prevents recovery of XML todo calls.
                repeatedVerificationReminder =
                  "This check already passed and repeated requests reuse that result, including " +
                  "requests with different output filters. Do not request it again without a " +
                  "relevant change. Continue the remaining implementation and update todo_write; " +
                  "tools remain available. If all requested work is complete, report the result.";
              }
            }
          }
          log.append({ sessionId, type: "tool_call_start", payload: { call } });
          const result: ToolResult = cachedSetupAction
            ? { ok: true as const, output: cachedSetupAction }
            : cachedVerification
              ? // cachedVerification is guaranteed to have passed (see the guard above).
                {
                  ok: true as const,
                  output: cachedVerification.detail,
                  verificationControl: cachedVerification.control,
                  verification: cachedVerification.execution,
                }
              : await dispatcher.dispatch({
                  tool: call.name,
                  args: call.args,
                  context: {
                    projectDir,
                    abortSignal,
                    sessionId,
                    sessionTodos: this.latestTodosBySession.get(sessionId),
                    allowOutsideProject: this.opts.allowOutsideProject?.() ?? false,
                  },
                  permission: { decision },
                });
          if (completionAuditRequested && result.ok && !cachedVerification) {
            if (result.diff && result.diff.before !== result.diff.after) auditRepairStarted = true;
            if (auditRepairStarted && verificationKey && !maskedVerification)
              auditRepairVerified = true;
          }
          if (verificationKey) {
            const status = `\nVerification record: ${JSON.stringify({ check: verificationKey, editEpoch: trackedEditEpoch, reused: Boolean(cachedVerification), ...(result.verification ?? {}) })}`;
            if (result.ok) result.output = (result.output ?? "") + status;
            else result.errorMessage = (result.errorMessage ?? "verification failed") + status;
          }
          const toolMadeProgress =
            !cachedVerification && retrievalToolMadeProgress(turnRetrievalKind, call.name, result);
          if (!cachedVerification && !cachedSetupAction) {
            if (result.ok) successfulToolCalls++;
            else failedToolCalls++;
            if (result.ok && !toolMadeProgress) unproductiveToolCalls++;
          }
          let artifactFidelityFeedback: string | null = null;
          let artifactFidelityValidatedThisCall = false;
          const priorRetrievalIdentifierEvidence = retrievalIdentifierEvidence;
          if (
            decision === "allow" &&
            turnRetrievalKind !== null &&
            result.ok &&
            typeof result.output === "string"
          ) {
            retrievalIdentifierEvidence = `${retrievalIdentifierEvidence}\n${result.output}`.slice(
              -64_000,
            );
          }
          if (call.name === "smoke_run" && !cachedVerification) smokeAttempted = true;
          if (setupActionKey && result.ok && !cachedSetupAction) {
            successfulSetupActions.set(
              setupActionKey,
              result.output ?? "dependency setup succeeded",
            );
          }
          const fetchedJsonEvidence = successfulFetchedJsonEvidence(
            call.name,
            call.args,
            result,
            this.trimBySession.get(sessionId)?.liveCap,
          );
          if (fetchedJsonEvidence) {
            fetchedJsonUrls.add(fetchedJsonEvidence.url);
            if (fetchedJsonEvidence.fullyVisible) {
              fullyVisibleFetchedJsonUrls.add(fetchedJsonEvidence.url);
            }
            const parsed = fetchedJsonBody(result.output);
            if (parsed) {
              latestFetchedJsonSource = {
                url: fetchedJsonEvidence.url,
                ...parsed,
                identityGrounded: fetchedArtifactIdentityGrounded({
                  request: userInput,
                  url: fetchedJsonEvidence.url,
                  raw: parsed.raw,
                  priorEvidence: priorRetrievalIdentifierEvidence,
                  coordinatesGrounded: urlCoordinatesGrounded === true,
                }),
              };
            }
          }
          const completedDownload =
            turnRetrievalKind === "data_artifact" && result.ok
              ? downloadRequest(call.name, call.args)
              : null;
          if (completedDownload?.writesFile) {
            for (const url of completedDownload.urls) directlyDownloadedJsonUrls.add(url);
            if (completedDownload.destination) {
              const cwd = (call.args as { cwd?: unknown } | undefined)?.cwd;
              const downloadCwd =
                typeof cwd === "string" && cwd.trim() ? resolve(projectDir, cwd) : projectDir;
              const destination = resolve(downloadCwd, completedDownload.destination);
              artifactWrittenPaths.add(destination);
              if (
                latestFetchedJsonSource?.identityGrounded &&
                completedDownload.urls.includes(latestFetchedJsonSource.url)
              ) {
                fidelityValidatedPaths.add(destination);
                const displayPath = relative(projectDir, destination);
                deterministicArtifactCompletion = `Saved the exact fetched JSON to \`${displayPath && !displayPath.startsWith("..") ? displayPath : destination}\`.`;
                artifactFidelityValidatedThisCall = true;
              }
            }
          }
          if (
            turnRetrievalKind === "data_artifact" &&
            result.ok &&
            result.diff?.path &&
            PATH_WRITING_TOOLS.has(call.name)
          ) {
            artifactWrittenPaths.add(resolve(result.diff.path));
          }
          if (
            turnRetrievalKind === "data_artifact" &&
            result.ok &&
            result.diff?.path &&
            call.name === "save_fetched_json"
          ) {
            const destination = resolve(result.diff.path);
            fidelityValidatedPaths.add(destination);
            const displayPath = relative(projectDir, destination);
            deterministicArtifactCompletion = `Saved the exact fetched JSON to \`${displayPath && !displayPath.startsWith("..") ? displayPath : destination}\`.`;
            artifactFidelityValidatedThisCall = true;
          } else if (
            turnRetrievalKind === "data_artifact" &&
            exactFetchedArtifactRequested &&
            latestFetchedJsonSource &&
            result.ok &&
            result.diff?.path &&
            call.name === "write_file"
          ) {
            const destination = resolve(result.diff.path);
            const parsedDestination = parseJsonDestination(result.diff.after);
            if (parsedDestination.error) {
              artifactFidelityFeedback = `ARTIFACT FIDELITY FAILED: The destination is not valid JSON (${parsedDestination.error}). Use save_fetched_json with URL ${latestFetchedJsonSource.url} and path ${(call.args as { path?: string }).path ?? destination} to preserve the exact complete response.`;
            } else {
              const issues = jsonFidelityIssues(
                latestFetchedJsonSource.value,
                parsedDestination.value,
              );
              if (issues.length === 0) {
                fidelityValidatedPaths.add(destination);
                const displayPath = relative(projectDir, destination);
                deterministicArtifactCompletion = `Saved the exact fetched JSON to \`${displayPath && !displayPath.startsWith("..") ? displayPath : destination}\`.`;
                artifactFidelityValidatedThisCall = true;
              } else {
                artifactFidelityFeedback = [
                  "ARTIFACT FIDELITY FAILED: The written JSON does not completely match the fetched source.",
                  ...issues.map((issue) => `- ${issue}`),
                  `Use save_fetched_json with URL ${latestFetchedJsonSource.url} and path ${(call.args as { path?: string }).path ?? destination}; do not manually reconstruct the payload.`,
                ].join("\n");
              }
            }
          }
          // Only allowed executions and model-correctable call failures inform routing. Policy,
          // permission, and scope denials cannot be repaired by spending a larger-model call.
          if (decision === "allow") {
            const identifierResolutionSearch =
              call.name === "web_search" &&
              identifierResolutionSearchEligibleLoop === loop &&
              identifierResolutionSearchCreditAvailable;
            if (identifierResolutionSearch) {
              identifierResolutionSearchEligibleLoop = null;
              identifierResolutionSearchCreditAvailable = false;
              log.append({
                sessionId,
                type: "notice",
                payload: {
                  text: "retrieval identifier resolution: allowed one evidence search after blocking an ungrounded identifier without treating it as a phase regression",
                  level: "info",
                  kind: "retrieval_identifier_resolution",
                },
              });
            }
            if (
              retrievalDiscoveryStalled(turnRetrievalKind, call.name, routingRetrievalSearches) &&
              !identifierResolutionSearch &&
              !routingRetrievalStalled
            ) {
              routingRetrievalStalled = true;
              log.append({
                sessionId,
                type: "notice",
                payload: {
                  text: "retrieval returned to broad discovery after already selecting sources; marking the current tier stalled for smart-routing recovery",
                  level: "info",
                  kind: "retrieval_stalled",
                },
              });
            }
            if (turnRetrievalKind !== null && call.name === "web_search") {
              routingRetrievalSearches++;
            }
            recordRoutingToolOutcome(toolMadeProgress);
          }
          if (cachedVerification) {
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: `verification cache: reused ${summary} because no tracked files changed`,
                level: "info",
                kind: "verification_cache",
              },
            });
          }
          if (cachedSetupAction) {
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: `successful action cache: reused ${summary} because it already succeeded this turn`,
                level: "info",
                kind: "successful_action_cache",
              },
            });
          }
          // This guard is for a model stuck trying forbidden mutations, not a lifetime mistake
          // counter. A successful allowed inspection proves the plan turn is making progress and
          // breaks the streak (clet3 made 29 useful reads between three scattered bash attempts).
          if (result.ok && this.opts.planMode?.() && !isMutating(tool)) {
            planBlockedStreak = 0;
          }
          // Track the session's working list: any result carrying todos WITHOUT a
          // todosTitle is the working list (todo_write, todo_list_load); titled
          // results (named lists) are not.
          if (result.todos !== undefined && result.todosTitle === undefined) {
            if (
              trackerPhaseReminder &&
              todoTransitionSatisfied(
                trackerPhaseReminder.priorTodos,
                trackerPhaseReminder.to,
                result.todos,
              )
            ) {
              trackerPhaseReminder = null;
            }
            this.latestTodosBySession.set(sessionId, result.todos);
            // Loading a list is not the model reporting progress. It can replace a todo_write
            // earlier in this turn, so retain the source of the current list rather than a
            // monotonic "any list update" flag.
            workingTodosWrittenThisTurn = call.name === "todo_write";
            if (result.ok && call.name === "todo_write") todoReconciliationPending = false;
          }
          if (result.ok && result.diff?.path && this.opts.checkpoints) {
            try {
              this.opts.checkpoints.recordFile(
                result.diff.path,
                result.diff.before,
                result.diff.created ?? false,
              );
            } catch {
              // checkpoint capture is advisory; never break the tool-call loop
            }
          }
          log.append({ sessionId, type: "tool_call_end", payload: { call, ...result } });
          if (verificationKey) {
            const maskedExit = maskedVerification;
            const previousVerification = verificationResults.get(verificationKey);
            const baseline = verificationKey.endsWith(":baseline");
            const scope =
              verificationKey === "run_tests:full" ||
              /^bash:(?:bun test|bun run test|bunx (?:vitest(?: run)?|jest|playwright test|cypress run|mocha|ava)|pytest|uv run pytest|cargo test|go test|swift test)\s*$/i.test(
                verificationKey,
              )
                ? "full"
                : "focused";
            const detail = maskedExit
              ? "verification command's exit status can be replaced by a later shell command; rerun it alone, or capture status=$?, perform cleanup, then exit $status"
              : result.ok
                ? (result.output ?? "passed")
                : (result.errorMessage ?? result.output ?? "verification failed");
            const verificationOk =
              !maskedExit && verificationSucceeded(call.name, result.ok, detail);
            const evidence = verificationEvidence(call.name, call.args);
            verificationResults.set(verificationKey, {
              key: verificationKey,
              command: result.verification?.command ?? summary,
              control: result.verificationControl,
              execution: result.verification,
              ok: verificationOk,
              detail: detail.split("\nVerification record:")[0]!,
              evidence,
              scope,
              baseline,
              failureIds: verificationFailureIds(detail),
            });
            if (!maskedExit && replayContext !== null) {
              verificationEpochs.set(verificationKey, trackedEditEpoch);
              verificationReplayContexts.set(verificationKey, replayContext);
            } else {
              verificationEpochs.delete(verificationKey);
              verificationReplayContexts.delete(verificationKey);
            }
            if (verificationClosesSourceLease(evidence, verificationKey)) {
              if (verificationOk) {
                routingVerifiedSourceEditEpoch = routingSourceEditEpoch;
              } else {
                routingFailedVerificationEpoch = routingSourceEditEpoch;
              }
            }
            if (verificationOk && previousVerification?.ok !== true) {
              rememberAction(`verification passed: ${summary}`);
            }
          }
          const currentTodos = this.latestTodosBySession.get(sessionId) ?? [];
          const phaseTransition: { from: number; to: number } | null =
            result.ok && call.name !== "todo_write" && trackerPhaseReminder === null
              ? observedTodoPhaseTransition({
                  todos: currentTodos,
                  tool: call.name,
                  args: call.args,
                  diffPath: result.diff?.path,
                  fullVerification:
                    verificationKey !== null &&
                    verificationResults.get(verificationKey)?.scope === "full",
                })
              : null;
          if (phaseTransition) {
            trackerPhaseReminder = {
              priorTodos: currentTodos.map((todo) => ({ ...todo })),
              ...phaseTransition,
            };
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: `tracker checkpoint: observed activity for "${currentTodos[phaseTransition.to]!.content}" while "${currentTodos[phaseTransition.from]!.content}" remained active`,
                level: "info",
                kind: "todo_phase_transition",
              },
            });
          }
          let baseContent = result.ok
            ? (result.output ?? "")
            : `error: ${result.errorMessage ?? "tool failed"}`;
          if (cachedSetupAction) {
            baseContent = `Reused the earlier successful dependency setup; the command was not executed again.\n${baseContent}`;
          }
          if (phaseTransition) {
            const from = currentTodos[phaseTransition.from]!;
            const to = currentTodos[phaseTransition.to]!;
            const checkpoint = `TRACKER REMINDER: This successful activity appears to belong to the later named step "${to.content}", while "${from.content}" is still in_progress. Reconcile the full list with todo_write when appropriate, but continue useful work; this observation alone is not evidence that either step is complete.`;
            baseContent = baseContent ? `${baseContent}\n\n${checkpoint}` : checkpoint;
          }
          if (artifactFidelityFeedback) {
            baseContent = baseContent
              ? `${baseContent}\n\n${artifactFidelityFeedback}`
              : artifactFidelityFeedback;
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: "the JSON write differed structurally from the complete fetched source; requested an exact cached save",
                level: "warn",
                kind: "artifact_fidelity_mismatch",
              },
            });
          }
          if (artifactFidelityValidatedThisCall) {
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: "exact fetched JSON fidelity verified; completed deterministically without another model call",
                level: "info",
                kind: "artifact_deterministic_completion",
              },
            });
          }
          const retrievalMiss = retrievalMissNudge(turnRetrievalKind, call.name, result);
          if (retrievalMiss) {
            baseContent = baseContent ? `${baseContent}\n\n${retrievalMiss}` : retrievalMiss;
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: "retrieval made no progress; warned against inventing an intermediate identifier",
                level: "info",
                kind: "retrieval_miss",
              },
            });
          }
          if (
            retrievalFetchNudges < 2 ||
            (turnRetrievalKind === "data_artifact" && fetchedJsonEvidence !== null)
          ) {
            const retrievalNudge = retrievalFetchNudge(turnRetrievalKind, call.name, result.ok);
            if (retrievalNudge) {
              baseContent = baseContent ? `${baseContent}\n\n${retrievalNudge}` : retrievalNudge;
              retrievalFetchNudges++;
            }
          }
          if (verificationKey && call.name === "bash" && !maskedVerification) {
            const detail = result.ok
              ? (result.output ?? "passed")
              : (result.errorMessage ?? result.output ?? "verification failed");
            const compact = compactVerificationForModel(summary, result.ok, detail);
            baseContent = cachedVerification
              ? `Reused unchanged verification result; the command was not executed again.\n${compact}`
              : compact;
          }
          if (repeatedVerificationReminder) {
            baseContent = `${baseContent}\n\n${repeatedVerificationReminder}`;
          }
          if (result.ok && call.name === "read_file") {
            const pathArg = (call.args as { path?: unknown }).path;
            if (typeof pathArg === "string" && pathArg.length > 0) {
              const resolvedReadPath = resolve(projectDir, pathArg);
              const boundaryIndex = this.trimBySession.get(sessionId)?.boundaryIndex ?? 0;
              // A prior body is the model's verbatim copy only in the un-truncated region of the
              // sent tail: at/after the live-turn start (slimDeepHistory truncates older results to
              // maxDeepToolResultChars) AND at/after the frozen boundary (earlier is folded into the
              // digest). Use the higher of the two as the threshold below which we must re-send.
              const verbatimStart = Math.max(boundaryIndex, liveTurnStart(history));
              const r = this.readCacheForSession(sessionId).reconcile(
                resolvedReadPath,
                result.output ?? "",
                history.length, // the index this tool result will occupy when pushed below
                verbatimStart,
                this.trimBySession.get(sessionId)?.liveCap ?? Number.POSITIVE_INFINITY,
              );
              baseContent = r.content;
              if (
                turnRetrievalKind === "data_artifact" &&
                artifactWrittenPaths.has(resolvedReadPath) &&
                (result.output ?? "").trim().length > 0 &&
                (!exactFetchedArtifactRequested ||
                  latestFetchedJsonSource === null ||
                  fidelityValidatedPaths.has(resolvedReadPath))
              ) {
                artifactFinalSynthesisRequested = true;
                baseContent = `${baseContent}\n\nARTIFACT VALIDATED: The requested destination exists and returned readable content. Tool access is now closed for this turn. Report the saved path and any directly verified facts; do not perform more discovery, downloads, or reads.`;
                log.append({
                  sessionId,
                  type: "notice",
                  payload: {
                    text: "data artifact validated; closing tools for final synthesis",
                    level: "info",
                    kind: "artifact_final_synthesis",
                  },
                });
              }
            }
          }
          if (this.opts.hooks) {
            try {
              const post = await this.opts.hooks.runPostToolUse({
                sessionId,
                tool: call.name,
                args: call.args,
                summary,
                result: { ok: result.ok, output: result.output, error: result.errorMessage },
                signal: abortSignal,
              });
              if (post.feedback) {
                baseContent += `\n\n<hook-feedback>\n${post.feedback}\n</hook-feedback>`;
              }
            } catch {
              // contained: a post-hook failure never affects the tool result
            }
          }
          const entry = { role: "tool" as const, toolCallId: call.id, content: baseContent };
          history.push(entry);
          lastToolEntry = entry;
          if (
            turnRetrievalKind === "data_artifact" &&
            result.ok &&
            ((result.diff?.path && PATH_WRITING_TOOLS.has(call.name)) ||
              completedDownload?.writesFile)
          ) {
            const nudge = artifactFidelityValidatedThisCall
              ? "ARTIFACT VALIDATED: The destination exactly matches the complete fetched JSON. Tool access is now closed for this turn. Report the saved path and only directly verified facts."
              : "DATA ARTIFACT WRITTEN: Validate the destination once using a focused read or parse, then return the final response. Do not restart discovery or download the same source again.";
            entry.content = entry.content ? `${entry.content}\n\n${nudge}` : nudge;
          }
          if (!dataArtifactInventoryNudgeSent && result.ok) {
            const inventoryNudge = dataArtifactInventoryNudge(
              turnRetrievalKind,
              call.name,
              call.args,
            );
            if (inventoryNudge) {
              entry.content = entry.content
                ? `${entry.content}\n\n${inventoryNudge}`
                : inventoryNudge;
              dataArtifactInventoryNudgeSent = true;
              log.append({
                sessionId,
                type: "notice",
                payload: {
                  text: "data artifact efficiency: repository inventory is unnecessary; asked the model to proceed with the export",
                  level: "info",
                  kind: "retrieval_efficiency_nudge",
                },
              });
            }
          }
          const lgCfg = this.opts.loopGuard?.();
          if (lgCfg?.enabled) {
            let guard = this.loopGuardBySession.get(sessionId);
            if (!guard) {
              guard = new LoopGuard(lgCfg, projectDir);
              this.loopGuardBySession.set(sessionId, guard);
            }
            const argPath =
              (call.args as Record<string, unknown> | undefined)?.path ??
              (call.args as Record<string, unknown> | undefined)?.file_path;
            const readTarget = PATH_READING_TOOLS.has(call.name)
              ? await resolveReadTarget(call.name, call.args, projectDir)
              : null;
            const outOfTree =
              result.errorCode === "OUT_OF_TREE" ||
              readTarget?.escapes === true ||
              (PATH_WRITING_TOOLS.has(call.name) &&
                typeof argPath === "string" &&
                argPath.length > 0 &&
                (await pathEscapesProject(argPath, projectDir)));
            const warning = guard.observe(
              { name: call.name, args: call.args },
              { ok: result.ok, outOfTree },
            );
            if (warning) {
              entry.content = entry.content ? `${entry.content}\n\n${warning}` : warning;
              log.append({
                sessionId,
                type: "notice",
                payload: {
                  text: `loop guard: warned on repeated ${call.name} (${summary})`,
                  level: "warn",
                  kind: "loop_guard",
                },
              });
            }
            const probe = repeatedProbeGuard.observe(
              { name: call.name, args: call.args },
              { ok: result.ok, output: result.output },
            );
            if (probe?.kind === "warn") {
              const message =
                `The last ${probe.count} numbered diagnostic probes returned the same result. ` +
                "Stop changing only the probe label. Compare the result with the expected behavior, " +
                "then change the implementation or test, run a materially different check, or report what remains unresolved.";
              entry.content = `${entry.content}\n\n<loop-warning>\n${message}\n</loop-warning>`;
              log.append({
                sessionId,
                type: "notice",
                payload: { text: message, level: "warn", kind: "repeated_probe_warning" },
              });
            } else if (probe?.kind === "stop") {
              repeatedProbeStop = probe.count;
              repeatedProbeAdvice = repeatedProbeRecoveryAdvice(
                String((call.args as { command?: unknown } | null)?.command ?? ""),
              );
              break;
            }
            if (thrashRepeats > 0) {
              const sig = guard.thrashedSignature(thrashRepeats);
              if (sig) {
                // Clear the streak that just triggered the stop so a subsequent turn's retry
                // of the same command starts fresh instead of thrashing immediately again.
                guard.clearCmdFailStreak(sig);
                // A verification/test/build check thrashing is detected from the command itself
                // (main's loop-guard keys commands by their raw text).
                const isVerificationThrash =
                  /\b(?:vitest|jest|playwright|cypress|mocha|ava|pytest|bun\s+test|bun\s+run\s+(?:test|build|lint|typecheck|check)|tsc|eslint|biome)\b/i.test(
                    sig,
                  );
                if (
                  isVerificationThrash &&
                  successfulEdits > 0 &&
                  source !== "orchestration-worker"
                ) {
                  // A non-converging verification on a turn that built real work: close tool access
                  // and let the model deliver a final qualified summary (with this check recorded as
                  // an unresolved limitation) instead of discarding everything with a hard stop.
                  convergenceFinalRequested = true;
                  thrashVerificationLimit = sig.replace(/^cmd:(?:verify:)?/, "");
                  log.append({
                    sessionId,
                    type: "notice",
                    payload: {
                      text: `verification did not converge after repeated attempts; delivering the built work with \`${thrashVerificationLimit}\` recorded as an unresolved check`,
                      level: "warn",
                      kind: "verification_thrash_qualified",
                    },
                  });
                } else {
                  thrashStop = true;
                  thrashSig = sig;
                }
                break; // stop processing this batch; the outer loop breaks below
              }
            }
          }
          // Remember the step's edited paths + the last edit's result, so one coalesced
          // diagnostics check can attach its output after the loop (see below).
          // successfulEdits keys off `result.diff?.path` (only the structured write tools emit a
          // diff), while failedWrites keys off PATH_WRITING_TOOLS membership — an intentional
          // asymmetry: the success side can only over-count in the safe direction (a stray diff
          // raises successfulEdits, which can only make workerFailedToProduceChanges return false).
          if (result.ok && result.diff?.path) {
            editedPaths.push(result.diff.path);
            successfulEdits++;
            trackedEditEpoch++;
            // A passing check describes the tree before this edit and must not support final
            // completion claims afterward. Isolated-baseline evidence describes a separate tree
            // and remains useful for classifying known failures.
            for (const [key, verification] of verificationResults) {
              if (!verification.baseline) verificationResults.delete(key);
            }
            const relativePath = relative(projectDir, result.diff.path);
            if (isImplementationPath(relativePath)) routingSourceEditEpoch++;
            turnEditedPaths.add(relativePath);
            successfulSetupActions.clear();
            postVerificationInspectedPaths.clear();
            postVerificationInspectionBlocks = 0;
            const priorSnapshot = editedFileSnapshots.get(relativePath);
            editedFileSnapshots.set(relativePath, {
              path: relativePath,
              before: priorSnapshot?.before ?? result.diff.before,
              after: result.diff.after,
              created: priorSnapshot?.created ?? result.diff.created,
            });
            lastEditEntry = entry;
            lastEditCallId = call.id;
            tokensSinceLastEdit = 0;
            noProgressGraceUsed = false;
            rememberAction(`edited ${relative(projectDir, result.diff.path)}`);
          } else if (PATH_WRITING_TOOLS.has(call.name) && !result.ok) {
            failedWrites++;
          }
          if (result.ok) {
            const inspected = completionAuditInspectionPath(call.name, call.args, projectDir);
            if (inspected) {
              turnInspectedPaths.add(inspected);
              if (
                !completionAuditRequested &&
                [...verificationResults.values()].some((verification) => verification.ok)
              ) {
                postVerificationInspectedPaths.add(inspected);
              }
            }
          }
          if (protectExisting && result.ok) {
            let touchedAbs: string | undefined;
            if (PATH_WRITING_TOOLS.has(call.name)) {
              // Every write tool emits diff.path = resolve(projectDir, <target>) — tool-agnostic
              // and covers apply_patch, whose target lives inside the `patch` arg text rather
              // than a `path`/`file_path` arg.
              touchedAbs = result.diff?.path;
            } else if (call.name === "read_file") {
              const p = (call.args as Record<string, unknown> | undefined)?.path;
              if (typeof p === "string" && p.length > 0) touchedAbs = resolve(projectDir, p);
            }
            if (touchedAbs) this.touchedPathsForSession(sessionId).add(touchedAbs);
          }
          resolvedCallIds.add(call.id);
        }

        if (
          !inspectionBatchNudgeSent &&
          singleInspectionRoundStreak >= SINGLE_INSPECTION_BATCH_NUDGE_ROUNDS &&
          lastToolEntry
        ) {
          const nudge =
            "EFFICIENCY NUDGE: You have made four consecutive model rounds with one inspection tool. If you already know multiple independent reads, searches, or checks needed next, issue them together in one tool-call batch. Keep calls sequential when a result determines the next target.";
          lastToolEntry.content = lastToolEntry.content
            ? `${lastToolEntry.content}\n\n${nudge}`
            : nudge;
          inspectionBatchNudgeSent = true;
          log.append({
            sessionId,
            type: "notice",
            payload: {
              text: "efficiency nudge: suggested batching known-independent inspection calls",
              level: "info",
              kind: "inspection_batch_nudge",
            },
          });
        }

        // Some tool-oriented models keep inventorying a repository long after they have enough
        // context to begin. Give editing workers one recency-positioned course correction before
        // the broader token/time guards fire. Explore workers never receive this nudge.
        if (workerRequiresEdit && successfulEdits === 0 && editedPaths.length === 0) {
          readOnlyToolRoundsBeforeFirstEdit++;
          if (
            !editNudgeSent &&
            readOnlyToolRoundsBeforeFirstEdit >= WORKER_EDIT_NUDGE_ROUNDS &&
            lastToolEntry
          ) {
            const nudge =
              "ORCHESTRATION COURSE CORRECTION: You have enough repository context. Stop inventorying and make the smallest viable file edit now, then verify it. Do not spend another round only reading or searching.";
            lastToolEntry.content = lastToolEntry.content
              ? `${lastToolEntry.content}\n\n${nudge}`
              : nudge;
            editNudgeSent = true;
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: "worker edit nudge: inspection limit reached; asked worker to edit now",
                level: "warn",
              },
            });
          }
        }

        // Autoformat, coalesced: reformat the step's edited files in place BEFORE diagnostics run
        // (so diagnostics see the final content), then attach a terse notice to the last edit's
        // tool result. Advisory side-channel — a throw never breaks the turn.
        if (editedPaths.length > 0 && this.opts.formatter && lastEditEntry) {
          try {
            const changed = await this.opts.formatter.formatFiles(editedPaths, abortSignal);
            const text = formatNotice(changed);
            if (text) {
              latestDiagnostics = text;
              lastEditEntry.content = lastEditEntry.content
                ? `${lastEditEntry.content}\n\n${text}`
                : text;
              log.append({ sessionId, type: "notice", payload: { text } });
            }
          } catch {
            // A failing formatter must never break the tool-call loop.
          }
        }

        // Diagnostics, coalesced: run each affected checker once over the step's net change
        // and attach the combined report to the LAST file-mutating tool result, so the model
        // sees it before its next step. Advisory side-channel — a throw never breaks the turn.
        if (editedPaths.length > 0 && this.opts.diagnostics && lastEditEntry) {
          try {
            const reports = await this.opts.diagnostics.checkFiles(editedPaths, abortSignal);
            const text = reports
              .map((r) => r.text)
              .filter(Boolean)
              .join("\n");
            if (text) {
              lastEditEntry.content = lastEditEntry.content
                ? `${lastEditEntry.content}\n\n${text}`
                : text;
              log.append({
                sessionId,
                type: "diagnostics",
                payload: { callId: lastEditCallId, text },
              });
            }
          } catch {
            // A failing checker must never break the tool-call loop.
          }
        }

        if (permissionThrew) {
          // Fix D: resolvePermission threw mid-loop; push error tool results for every
          // call in the batch that did NOT already get a result (calls after the throwing
          // one), so the assistant message's toolCalls array is fully matched.
          for (const call of pendingToolCalls) {
            if (!resolvedCallIds.has(call.id)) {
              history.push({
                role: "tool",
                toolCallId: call.id,
                content: "error: permission resolution failed",
              });
            }
          }
          // Append a terminal assistant message so the turn ends consistently, then return.
          const note = "(stopped: permission resolution failed)";
          history.push({ role: "assistant", content: note });
          stoppedReason = "permission_error";
          log.append({
            sessionId,
            type: "assistant_message",
            payload: { text: note, stoppedReason },
          });
          assistantText = note;
          completedNormally = true; // history is now consistent
          break;
        }

        if (deterministicArtifactCompletion) {
          history.push({ role: "assistant", content: deterministicArtifactCompletion });
          log.append({
            sessionId,
            type: "assistant_message",
            payload: { text: deterministicArtifactCompletion },
          });
          assistantText = deterministicArtifactCompletion;
          completedNormally = true;
          break;
        }

        if (thrashStop || hiddenStop || repeatedProbeStop > 0) break;

        if (workerNoProgress > 0 && tokensSinceLastEdit >= workerNoProgress) {
          if (!noProgressGraceUsed) {
            noProgressGraceUsed = true;
            tokensSinceLastEdit = 0;
            const nudge =
              "ORCHESTRATION PROGRESS WARNING: No file edit has landed across one full inspection budget. Your investigation may be useful, so you have one final grace window. Use the context you gathered to make a targeted edit and verify it; if the task is genuinely blocked, explain the concrete blocker now.";
            if (lastToolEntry) {
              lastToolEntry.content = lastToolEntry.content
                ? `${lastToolEntry.content}\n\n${nudge}`
                : nudge;
            }
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: "worker progress warning: one inspection budget elapsed without a file edit; granted a final grace window",
                level: "warn",
              },
            });
          } else {
            noProgressStop = true;
            break;
          }
        }

        const convergenceFraction = this.opts.workerConvergenceFraction ?? 0;
        if (
          !convergenceFinalRequested &&
          workerBudget > 0 &&
          convergenceFraction > 0 &&
          convergenceFraction < 1 &&
          spentTokens >= workerBudget * convergenceFraction
        ) {
          convergenceFinalRequested = true;
          const nudge =
            "FINAL RESPONSE RESERVE: Tool access is now closed so the remaining budget can carry your required final response. Using the evidence already gathered, emit the requested result now. Mark anything still uncertain as failed/unverified; do not request more tools.";
          if (lastToolEntry) {
            lastToolEntry.content = lastToolEntry.content
              ? `${lastToolEntry.content}\n\n${nudge}`
              : nudge;
          }
          log.append({
            sessionId,
            type: "notice",
            payload: {
              text: "worker reached its evidence budget; reserving the remaining context for the required final response",
              level: "warn",
            },
          });
          continue;
        }

        if (
          !budgetWarned &&
          !convergenceFinalRequested &&
          workerBudget > 0 &&
          spentTokens >= workerBudget * 0.75
        ) {
          budgetWarned = true;
          const nudge =
            "WORKER COST WARNING: You have used about 75% of the normal billed-token budget. Prioritize the remaining acceptance criteria now: finish the smallest complete implementation, run focused verification, and report. Avoid optional investigation or polish.";
          if (lastToolEntry) {
            lastToolEntry.content = lastToolEntry.content
              ? `${lastToolEntry.content}\n\n${nudge}`
              : nudge;
          }
          log.append({
            sessionId,
            type: "notice",
            payload: {
              text: "worker cost warning: 75% of the normal token budget used; asked worker to finish acceptance work",
              level: "warn",
            },
          });
        }

        if (workerSoftBudget > 0 && spentTokens >= workerSoftBudget) {
          const extension = Math.min(
            this.opts.workerProgressExtensionTokens ?? 0,
            Math.max(0, workerHardBudget - workerSoftBudget),
          );
          if (
            budgetExtensions === 0 &&
            durableProgressEpoch > progressEpochAtBudgetBoundary &&
            extension > 0
          ) {
            progressEpochAtBudgetBoundary = durableProgressEpoch;
            workerSoftBudget += extension;
            budgetExtensions++;
            const nudge = `PROGRESS EXTENSION: Recent durable progress earned ${Math.round(extension / 1000)}k additional billed tokens. This is the final bounded stretch; complete remaining acceptance checks before the absolute ${Math.round(workerHardBudget / 1000)}k ceiling.`;
            if (lastToolEntry) {
              lastToolEntry.content = lastToolEntry.content
                ? `${lastToolEntry.content}\n\n${nudge}`
                : nudge;
            }
            log.append({
              sessionId,
              type: "notice",
              payload: {
                text: `worker reached the normal token-cost ceiling after making durable progress; granted a bounded ${Math.round(extension / 1000)}k extension`,
                level: "warn",
              },
            });
            continue;
          }
          budgetExhausted = true;
          break;
        }
      }

      // Exited the for-loop without a clean break: an explicit loop cap tripped, or forced
      // plan synthesis triggered. Plan mode gets its tool-less recovery; a configured cap gets
      // a deterministic incomplete checkpoint without spending another model call.
      if (!completedNormally) {
        if (auditLimit) {
          stoppedReason = "no_progress";
          const note = `Completion audit incomplete: ${auditLimit}. Changes are preserved; unresolved requirements remain unverified.\n\n${progressSummary()}`;
          history.push({ role: "assistant", content: note });
          log.append({
            sessionId,
            type: "assistant_message",
            payload: { text: note, stoppedReason },
          });
          assistantText = note;
        } else if (thrashStop) {
          stoppedReason = "thrash";
          const label = (thrashSig ?? "").replace(/^cmd:/, "");
          const note = `Stopped: the command \`${label}\` failed ${thrashRepeats} times without converging. It did not complete.`;
          history.push({ role: "assistant", content: note });
          log.append({
            sessionId,
            type: "assistant_message",
            payload: { text: note, stoppedReason: "thrash" },
          });
          assistantText = note;
        } else if (hiddenStop) {
          stoppedReason = "hidden_tools";
          const note =
            "Stopped: repeated calls to tools that are not available in this session. The alternatives were named in the error messages; the task did not complete.";
          history.push({ role: "assistant", content: note });
          log.append({
            sessionId,
            type: "assistant_message",
            payload: { text: note, stoppedReason: "hidden_tools" },
          });
          assistantText = note;
        } else if (noProgressStop) {
          stoppedReason = "no_progress";
          const k = Math.round(tokensSinceLastEdit / 1000);
          const note =
            `Stopped: two full inspection budgets elapsed without a file change (last window ~${k}k tokens) — no durable progress. Existing work is preserved. ` +
            "To continue, use the evidence already gathered to make one targeted change and run a focused check. " +
            "If the blocker is still unclear, report the observed result, the expected result, and the next experiment instead of repeating the same inspection.";
          // No synthesis call — it would add spend to a turn we are bailing on for
          // spending without landing edits.
          history.push({ role: "assistant", content: note });
          log.append({
            sessionId,
            type: "assistant_message",
            payload: { text: note, stoppedReason: "no_progress" },
          });
          assistantText = note;
        } else if (repeatedProbeStop > 0) {
          stoppedReason = "no_progress";
          const note =
            `Stopped: ${repeatedProbeStop} numbered diagnostic probes returned the same result without an intervening change. Existing work is preserved. ` +
            `Suggested fix: ${repeatedProbeAdvice}`;
          history.push({ role: "assistant", content: note });
          log.append({
            sessionId,
            type: "assistant_message",
            payload: { text: note, stoppedReason },
          });
          assistantText = note;
        } else if (budgetExhausted) {
          stoppedReason = "token_budget";
          const k = Math.round(spentTokens / 1000);
          const note = `Stopped: this task reached its ~${k}k billed-token cost ceiling. It did not complete.`;
          // No synthesis call — it would add the very spend we are bailing to avoid.
          history.push({ role: "assistant", content: note });
          log.append({
            sessionId,
            type: "assistant_message",
            payload: { text: note, stoppedReason: "token_budget" },
          });
          assistantText = note;
        } else if (forcePlanSynthesis) {
          const plan = await this.runForcedPlanSynthesis(history, abortSignal, sessionId, {
            ...routingHints,
            turnStartIndex,
          });
          // A deadline abort also sets abortSignal.aborted — reclassify before falling back
          // to the generic user-cancel text (see the model-call-loop cancel branch).
          const timedOut = turnDeadline.signal.aborted && !userSignal.aborted;
          if (timedOut) stoppedReason = "time_budget";
          const note = timedOut
            ? `Stopped: this task ran for over ${Math.round(deadlineMs / 1000)}s without converging. It did not complete.`
            : abortSignal.aborted
              ? "(cancelled)"
              : plan && plan.trim().length > 0
                ? plan
                : "Couldn't produce a plan automatically after repeated blocked tool attempts — try rephrasing, or use a stronger model.";
          history.push({ role: "assistant", content: note });
          log.append({
            sessionId,
            type: "assistant_message",
            payload: { text: note, ...(stoppedReason ? { stoppedReason } : {}) },
          });
          assistantText = note;
        } else {
          let note: string;
          let logStoppedReason: "loop_limit" | "cancelled" | "time_budget" = "loop_limit";
          if (abortSignal.aborted) {
            // A deadline abort also sets abortSignal.aborted — reclassify before falling back
            // to the generic user-cancel text (see the model-call-loop cancel branch).
            const timedOut = turnDeadline.signal.aborted && !userSignal.aborted;
            if (timedOut) {
              stoppedReason = "time_budget";
              logStoppedReason = "time_budget";
              note = `Stopped: this task ran for over ${Math.round(deadlineMs / 1000)}s without converging. It did not complete.`;
            } else {
              stoppedReason = "cancelled";
              note = "(cancelled)";
              logStoppedReason = "cancelled";
            }
          } else {
            const checkpoint = capCheckpointNote(capLimit);
            const deterministicProgress = progressSummary();
            note = [checkpoint, deterministicProgress]
              .filter((part): part is string => Boolean(part?.trim()))
              .join("\n\n");
          }
          stoppedReason = logStoppedReason;
          history.push({ role: "assistant", content: note });
          log.append({
            sessionId,
            type: "assistant_message",
            payload: { text: note, stoppedReason: logStoppedReason },
          });
          assistantText = note;
        }
      }

      return {
        assistantText,
        toolCalls: toolCallCount,
        successfulToolCalls,
        failedToolCalls,
        unproductiveToolCalls,
        successfulEdits,
        failedWrites,
        stoppedReason,
        editedPaths: [...turnEditedPaths],
        verificationResults: [...verificationResults.values()],
        progressSummary: progressSummary(),
        budgetExtensions,
      };
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }
}
