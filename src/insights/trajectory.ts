import { type TaskClass, classifyTask } from "../agent/coding-task";
import type { Event } from "../events/types";
import { CANCELLED_NOTE, LOOP_LIMIT_NOTE } from "./constants";

export type Outcome = "ok" | "error" | "cancelled" | "loop_limit";

export interface ModelCallSummary {
  tier: "small" | "large" | null;
  reason: string;
  finishReason: string;
  usage?: { input?: number; output?: number };
  /** Length of the call's terminal `reasoning` event text; 0 when the model emitted none. No
   * provider reports reasoning tokens separately (`usage.output` includes them), so this is the
   * raw material for estimating the thinking share. */
  reasoningChars: number;
}
export interface ToolCallSummary {
  name: string;
  ok: boolean;
  errorMessage?: string;
  durationMs: number;
}
export interface PermissionSummary {
  tool: string;
  argsSummary: string;
  decision: "allow" | "deny";
}
export interface Trajectory {
  sessionId: string;
  startTs: number;
  endTs: number;
  userInput: string;
  /** Same deterministic classifier the router applies to the turn's user message
   * (see src/agent/router.ts), recomputed at analysis time so historical sessions get it too. */
  taskClass: TaskClass;
  modelCalls: ModelCallSummary[];
  toolCalls: ToolCallSummary[];
  permissions: PermissionSummary[];
  loopCount: number;
  outcome: Outcome;
  incomplete: boolean;
}

// A finish-pass model call (router reason e.g. "speed: finish") is synthesis, not a
// tool-gathering loop, so it must not count toward loopCount. Keep this substring in
// sync with the router's finish-pass reason strings (see src/agent/router.ts).
const isFinishPass = (reason: string): boolean => reason.includes("finish");

function buildTrajectory(bucket: Event[]): Trajectory {
  const head = bucket[0]!; // bucket always has at least one event (the user_input)
  const sessionId = head.sessionId;
  const userInput = ((head.payload ?? {}) as { text?: string }).text ?? "";

  const modelCalls: ModelCallSummary[] = [];
  const modelById = new Map<string, ModelCallSummary>();
  const toolCalls: ToolCallSummary[] = [];
  const toolStartTs = new Map<string, number>();
  const permissions: PermissionSummary[] = [];
  let pendingPerm: { tool: string; argsSummary: string } | null = null;
  let loopCount = 0;
  let hasError = false;
  let hasAssistant = false;
  let lastAssistantText = "";
  let lastStoppedReason: string | undefined;

  for (const e of bucket) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case "model_call_start": {
        const reason = String(p.reason ?? "");
        const mc: ModelCallSummary = {
          tier: (p.tier as ModelCallSummary["tier"]) ?? null,
          reason,
          finishReason: "",
          usage: undefined,
          reasoningChars: 0,
        };
        modelCalls.push(mc);
        if (typeof p.callId === "string") modelById.set(p.callId, mc);
        if (!isFinishPass(reason)) loopCount++;
        break;
      }
      case "model_call_end": {
        const mc = typeof p.callId === "string" ? modelById.get(p.callId) : undefined;
        if (mc) {
          mc.finishReason = String(p.reason ?? "");
          mc.usage = p.usage as ModelCallSummary["usage"];
        }
        break;
      }
      case "reasoning": {
        const mc = typeof p.callId === "string" ? modelById.get(p.callId) : undefined;
        if (mc && typeof p.text === "string") mc.reasoningChars = p.text.length;
        break;
      }
      case "tool_call_start": {
        const call = p.call as { id?: string } | undefined;
        if (call?.id) toolStartTs.set(call.id, e.ts);
        break;
      }
      case "tool_call_end": {
        const call = p.call as { id?: string; name?: string } | undefined;
        const startedAt = call?.id ? toolStartTs.get(call.id) : undefined;
        toolCalls.push({
          name: call?.name ?? "?",
          ok: p.ok === true,
          errorMessage: typeof p.errorMessage === "string" ? p.errorMessage : undefined,
          durationMs: startedAt != null ? e.ts - startedAt : 0,
        });
        break;
      }
      case "permission_request": {
        pendingPerm = { tool: String(p.tool ?? "?"), argsSummary: String(p.summary ?? "") };
        break;
      }
      case "permission_decision": {
        if (pendingPerm) {
          permissions.push({
            tool: pendingPerm.tool,
            argsSummary: pendingPerm.argsSummary,
            decision: p.decision === "deny" ? "deny" : "allow",
          });
          pendingPerm = null;
        }
        break;
      }
      case "assistant_message": {
        // Intermediate tool-using steps also emit assistant_message now (per-step narration),
        // so this case fires multiple times per turn. These are last-wins: the terminal step's
        // message is always logged last and carries the real stoppedReason, so it wins.
        hasAssistant = true;
        lastAssistantText = String(p.text ?? "");
        lastStoppedReason = typeof p.stoppedReason === "string" ? p.stoppedReason : undefined;
        break;
      }
      case "error": {
        hasError = true;
        break;
      }
    }
  }

  const incomplete = !hasAssistant && !hasError;
  // Prefer the structured stoppedReason marker (new logs); fall back to the sentinel
  // assistant-message text for older logs recorded before the marker existed.
  let outcome: Outcome;
  if (hasError) outcome = "error";
  else if (lastStoppedReason === "cancelled" || lastAssistantText === CANCELLED_NOTE)
    outcome = "cancelled";
  else if (lastStoppedReason === "loop_limit" || lastAssistantText === LOOP_LIMIT_NOTE)
    outcome = "loop_limit";
  else outcome = "ok";

  return {
    sessionId,
    startTs: head.ts,
    endTs: bucket[bucket.length - 1]!.ts, // bucket always has at least one event
    userInput,
    taskClass: classifyTask(userInput),
    modelCalls,
    toolCalls,
    permissions,
    loopCount,
    outcome,
    incomplete,
  };
}

/** Split an ordered event stream into one trajectory per user_input turn. */
export function segmentTrajectories(events: Event[]): Trajectory[] {
  const buckets: Event[][] = [];
  let current: Event[] | null = null;
  for (const e of events) {
    if (e.type === "user_input") {
      if (current) buckets.push(current);
      current = [e];
    } else if (current) {
      current.push(e);
    }
    // events before the first user_input (session_start, etc.) are ignored
  }
  if (current) buckets.push(current);
  return buckets.map(buildTrajectory);
}
