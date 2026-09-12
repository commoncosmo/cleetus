import type { Event } from "../events/types";
import type { LearnableTurn, LearnedToolStep } from "./types";

export type LearnableTurnResult = { ok: true; turn: LearnableTurn } | { ok: false; reason: string };

const SECRET_KEY = /(?:api[-_]?key|authorization|cookie|password|secret|token)/i;
const SECRET_TEXT =
  /(\b(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+|((?:api[-_]?key|authorization|cookie|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi;
const MAX_OUTPUT_CHARS = 1_200;
const MAX_ARG_STRING_CHARS = 600;
const MAX_ARG_ARRAY_ITEMS = 20;
const MAX_ARG_OBJECT_ENTRIES = 30;
const MAX_TRACE_STEPS = 24;
const NON_SEMANTIC_EXECUTION_KEYS = new Set(["seconds", "timeout", "timeoutMs", "maxOutputChars"]);
const MUTATING_TOOLS = new Set([
  "apply_patch",
  "edit_file",
  "multi_edit",
  "scaffold",
  "save_fetched_json",
  "write_file",
]);
const VERIFICATION_TOOLS = new Set(["run_tests", "smoke_run"]);
const MUTATING_SHELL_COMMAND =
  /(?:^|[\s;&|])(?:create|init|install|add|remove|generate|scaffold|migrate|mkdir|mv|cp|touch)(?:\s|$)/i;

function redactText(value: string): string {
  return value.replace(SECRET_TEXT, (_match, authPrefix: string, assignmentPrefix: string) => {
    return `${authPrefix ?? assignmentPrefix ?? ""}[REDACTED]`;
  });
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    const redacted = redactText(value);
    return redacted.length <= MAX_ARG_STRING_CHARS
      ? redacted
      : `${redacted.slice(0, MAX_ARG_STRING_CHARS)}…[argument truncated]`;
  }
  if (Array.isArray(value)) {
    const bounded = value.slice(0, MAX_ARG_ARRAY_ITEMS).map((item) => redactValue(item));
    if (value.length > MAX_ARG_ARRAY_ITEMS)
      bounded.push(`[${value.length - bounded.length} omitted]`);
    return bounded;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const bounded = entries
      .slice(0, MAX_ARG_OBJECT_ENTRIES)
      .map(([childKey, child]) => [childKey, redactValue(child, childKey)]);
    if (entries.length > MAX_ARG_OBJECT_ENTRIES) {
      bounded.push(["_omitted", `${entries.length - bounded.length} fields`]);
    }
    return Object.fromEntries(bounded);
  }
  return value;
}

function boundedOutput(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const redacted = redactText(value.trim());
  if (redacted.length <= MAX_OUTPUT_CHARS) return redacted;
  const tail = 240;
  return `${redacted.slice(0, MAX_OUTPUT_CHARS - tail)}\n…[trace excerpt truncated]…\n${redacted.slice(-tail)}`;
}

function canonicalExecutionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalExecutionValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !NON_SEMANTIC_EXECUTION_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalExecutionValue(child)]),
  );
}

function equivalentStepSignature(step: LearnedToolStep): string {
  return `${step.name}:${JSON.stringify(canonicalExecutionValue(step.args))}:${step.ok}`;
}

/** Repeated verification attempts with only timeout/display knobs changed are one trajectory
 * action, not independent evidence. Keep the latest result and record how many attempts it
 * represents so synthesis still understands that recovery was necessary. */
function collapseEquivalentSteps(steps: LearnedToolStep[]): LearnedToolStep[] {
  const out: LearnedToolStep[] = [];
  for (const step of steps) {
    const previous = out.at(-1);
    if (previous && equivalentStepSignature(previous) === equivalentStepSignature(step)) {
      out[out.length - 1] = {
        ...step,
        repeatCount: (previous.repeatCount ?? 1) + (step.repeatCount ?? 1),
      };
    } else {
      out.push(step);
    }
  }
  return out;
}

function shellCommand(step: LearnedToolStep): string {
  if (step.name !== "bash" || !step.args || typeof step.args !== "object") return "";
  const command = (step.args as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
}

function salienceScore(step: LearnedToolStep, index: number, count: number): number {
  let score = 0;
  if (index < 4 || index >= count - 4) score += 1_000;
  if (!step.ok) score += 900;
  if (MUTATING_TOOLS.has(step.name)) score += 800;
  if (MUTATING_SHELL_COMMAND.test(shellCommand(step))) score += 700;
  if (VERIFICATION_TOOLS.has(step.name)) score += 500;
  const recency = count <= 1 ? 0 : index / (count - 1);
  return score + recency;
}

/** Keep a bounded but representative trajectory. Boundary context remains, while failures,
 * mutations, setup commands, and verification outrank routine inventory. Selected steps retain
 * their original order so the synthesizer sees the actual recovery sequence. */
function salientSteps(steps: LearnedToolStep[]): LearnedToolStep[] {
  const collapsed = collapseEquivalentSteps(steps);
  if (collapsed.length <= MAX_TRACE_STEPS) return collapsed;
  return collapsed
    .map((step, index) => ({
      step,
      index,
      score: salienceScore(step, index, collapsed.length),
    }))
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, MAX_TRACE_STEPS)
    .sort((left, right) => left.index - right.index)
    .map(({ step }) => step);
}

/** Extract the most recent completed user turn from one session's ordered event stream.
 *
 * Eligibility is deliberately conservative but not self-reported: the turn must have a terminal
 * assistant event, no runtime error/structured stop, and at least one successful tool result.
 * Explicit user review remains the final promotion gate.
 */
export function latestLearnableTurn(events: Event[]): LearnableTurnResult {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "user_input") {
      start = i;
      break;
    }
  }
  if (start < 0) return { ok: false, reason: "this session has no completed user turn to learn" };

  const bucket = events.slice(start);
  const head = bucket[0]!;
  const userInput = String((head.payload as { text?: string } | null)?.text ?? "").trim();
  if (!userInput) return { ok: false, reason: "the most recent turn has no user request" };

  let terminalAssistant: Event | undefined;
  let hasError = false;
  const invokedSkillNames: string[] = [];
  for (const event of bucket) {
    if (event.type === "assistant_message") terminalAssistant = event;
    if (event.type === "error") hasError = true;
    if (event.type === "notice") {
      const payload = event.payload as { kind?: string; skills?: unknown } | null;
      if (payload?.kind === "skill_auto_invoked" && Array.isArray(payload.skills)) {
        for (const name of payload.skills) {
          if (typeof name === "string" && name.trim() && !invokedSkillNames.includes(name.trim())) {
            invokedSkillNames.push(name.trim());
          }
        }
      }
    }
  }
  if (hasError) return { ok: false, reason: "the most recent turn ended with a runtime error" };
  if (!terminalAssistant) {
    return { ok: false, reason: "the most recent turn has not produced a final response yet" };
  }
  const terminalPayload = terminalAssistant.payload as {
    text?: string;
    stoppedReason?: string;
  } | null;
  if (terminalPayload?.stoppedReason) {
    return {
      ok: false,
      reason: `the most recent turn stopped before completion (${terminalPayload.stoppedReason})`,
    };
  }

  const requests = new Map<string, { name: string; args: unknown }>();
  const steps: LearnedToolStep[] = [];
  for (const event of bucket) {
    const payload = event.payload as Record<string, unknown> | null;
    if (event.type === "tool_call_request") {
      const call = payload?.call as { id?: string; name?: string; args?: unknown } | undefined;
      if (call?.id && call.name) {
        requests.set(call.id, { name: call.name, args: redactValue(call.args ?? {}) });
      }
      continue;
    }
    if (event.type !== "tool_call_end") continue;
    const call = payload?.call as { id?: string; name?: string; args?: unknown } | undefined;
    const request = call?.id ? requests.get(call.id) : undefined;
    const name = request?.name ?? call?.name ?? "?";
    steps.push({
      name,
      args: request?.args ?? redactValue(call?.args ?? {}),
      ok: payload?.ok === true,
      output: boundedOutput(payload?.output),
      errorMessage:
        typeof payload?.errorMessage === "string" ? redactText(payload.errorMessage) : undefined,
    });
  }

  if (!steps.some((step) => step.ok)) {
    return {
      ok: false,
      reason: "the most recent turn has no successful tool evidence to turn into a playbook",
    };
  }
  return {
    ok: true,
    turn: {
      sessionId: head.sessionId,
      startTs: head.ts,
      endTs: terminalAssistant.ts,
      userInput,
      assistantText: redactText(String(terminalPayload?.text ?? "")).slice(0, 2_000),
      steps: salientSteps(steps),
      invokedSkillNames,
    },
  };
}
