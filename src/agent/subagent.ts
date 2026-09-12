import { ulid } from "ulid";
import type { CheckpointRecorder } from "../checkpoint/types";
import { ToolDispatcher } from "../tools/dispatcher";
import { ToolRegistry } from "../tools/registry";
import { type SpawnSubagent, type SubagentType, filterToolsForType } from "../tools/subagent/tool";
import { stampActor } from "./actor-log";
import { REVIEWER_PREAMBLE } from "./review";
import { AgentRuntime, type AgentRuntimeOptions } from "./runtime";
import type { VerificationResult } from "./types";

const PREAMBLE: Record<SubagentType, string> = {
  general:
    "You are a sub-agent working on a single delegated task. Complete it autonomously using " +
    "your tools, then reply with a concise summary of what you did and any key result — your " +
    "final message is the ONLY thing returned to the agent that delegated to you. You cannot " +
    "delegate further.",
  explore:
    "You are a read-only investigation sub-agent. You can read, search, and inspect, but you " +
    "cannot modify files or run commands. Investigate the delegated task and reply with a " +
    "concise summary of your findings — your final message is the ONLY thing returned to the " +
    "agent that delegated to you. You cannot delegate further.",
  review: REVIEWER_PREAMBLE,
};

/** Recency-positioned voice directive appended to a sub-agent's prompt when a personality voice is
 *  active. The full voice spec already rides in `base` (the parent prompt), but the terse-reporter
 *  preamble buries it, so worker-visible output comes out voiceless without this trailing nudge.
 *  References the voice already in context rather than re-stating it (kept cheap — runs per worker). */
const SUBAGENT_VOICE_NOTE =
  "VOICE: a personality voice is active (fully described in your instructions above). Your " +
  "narration and your final summary are shown to the user, so deliver them in that voice — keep " +
  "the summary concise, but in-character. Apply it to conversational prose ONLY: never to code, " +
  "identifiers, file paths, diffs, commit messages, tool arguments, or command output.";

/** The sub-agent's system prompt: a role preamble layered on the parent's full prompt (so the
 *  sub-agent keeps the environment / repo-map / instructions grounding). When `voiced`, a trailing
 *  voice directive is appended so user-visible worker output speaks in the active personality;
 *  `voiced=false` is byte-identical to omitting it. */
export function subagentSystemPrompt(type: SubagentType, base: string, voiced = false): string {
  const parts = [PREAMBLE[type], base];
  if (voiced) parts.push(SUBAGENT_VOICE_NOTE);
  return parts.join("\n\n");
}

/** A recorder that forwards file snapshots to the parent's checkpoint but never opens
 *  its own checkpoint — so a sub-run's edits are captured by the PARENT turn's /rewind
 *  without clobbering the parent's open checkpoint. */
function wrapRecorder(parent: CheckpointRecorder | undefined): CheckpointRecorder | undefined {
  if (!parent) return undefined;
  return {
    begin() {
      /* no-op: the parent turn's checkpoint stays current */
    },
    recordFile: (path, before, created) => parent.recordFile(path, before, created),
  };
}

/**
 * Build the function the `task` tool calls to launch a sub-agent. Closes over the parent
 * runtime's options; each spawn constructs a fresh AgentRuntime sharing those options with
 * three swaps — filtered tools (per type; `task` excluded), the checkpoint wrapper, and no
 * historyStore + a subagent system prompt — then runs one isolated turn and returns its result.
 */
export function buildSubagentSpawner(parentOpts: AgentRuntimeOptions): SpawnSubagent {
  return async ({ type, prompt, signal }) => {
    const subTools = new ToolRegistry();
    for (const t of filterToolsForType(parentOpts.tools, type)) subTools.register(t);
    const subRuntime = new AgentRuntime({
      ...parentOpts,
      tools: subTools,
      dispatcher: new ToolDispatcher(subTools),
      checkpoints: wrapRecorder(parentOpts.checkpoints),
      historyStore: undefined,
      systemPrompt: () => subagentSystemPrompt(type, parentOpts.systemPrompt()),
      smallSystemPrompt: parentOpts.smallSystemPrompt
        ? () => subagentSystemPrompt(type, parentOpts.smallSystemPrompt!())
        : undefined,
    });
    return subRuntime.runTurn(`sub-${ulid()}`, prompt, signal, "subagent");
  };
}

/** Worker-spawn request for orchestration: like SpawnSubagent but carries the task id for tagging. */
export type SpawnWorker = (req: {
  type: SubagentType;
  prompt: string;
  signal: AbortSignal;
  taskId: string;
  title: string;
  /** Still-pending task titles at dispatch time — the pending-scope guard consults these to refuse
   *  a brand-new write that belongs to a later task. Absent → [] (guard sees nothing pending). */
  pendingTitles?: string[];
  /** Explicit files named by the structured task; protects unrelated package/build infrastructure. */
  ownedPaths?: string[];
  /** Execution-framed skill reminders to inject into this worker's turn (from the frozen
   *  objective). Deduped against the worker's own task-text triggers. Absent → none. */
  seedReminders?: string[];
  /** Internal machine protocol is retained in the event log but omitted from TUI transcript rows. */
  protocolOutput?: boolean;
  /** Add a recency-positioned warning to return a final result before optional investigation. */
  convergeEarly?: boolean;
}) => Promise<{
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
  /** Project-relative paths this worker's turn wrote/edited — threaded into the completed
   *  task's `PlanTask.producedFiles` so later workers' "Already done" digest can point at
   *  real artifacts instead of bare titles. */
  editedPaths: string[];
  verificationResults?: VerificationResult[];
  progressSummary?: string;
  budgetExtensions?: number;
}>;

/**
 * Build the orchestration worker spawner: each worker runs in a context-isolated sub-runtime
 * (as in buildSubagentSpawner) BUT logs its events to the parent's `sessionId`, stamped
 * `actor: {role:"worker", taskId}` — so worker activity is visible in the main TUI and
 * attributable in the event log. History stays isolated (historyStore undefined). The
 * sub-runtime's `triggeredSkillReminders` is unconditionally wrapped to union the per-spawn
 * `seedReminders` (the orchestration skill seed) with the worker's own task-text triggers —
 * resolved via `opts.workerSkillSeed` (execute-scoped; Task 6), NOT the parent's unscoped
 * `triggeredSkillReminders` — deduped; an absent `workerSkillSeed` leaves the base empty.
 */
export function buildOrchestrationWorkerSpawner(
  parentOpts: AgentRuntimeOptions,
  opts: {
    sessionId: string;
    voiceOverlay?: () => string;
    /** Execute-scoped task-text resolver (Task 5/6): replaces the parent's unscoped
     *  `triggeredSkillReminders` as the worker's `base`, so a decompose-only skill (e.g. TDD)
     *  never reaches a worker via task text. Absent → base is empty (disabled path). */
    workerSkillSeed?: (input: string) => string[];
  },
): SpawnWorker {
  return async ({
    type,
    prompt,
    signal,
    taskId,
    title,
    pendingTitles,
    ownedPaths,
    seedReminders,
    protocolOutput,
    convergeEarly,
  }) => {
    const seed = seedReminders ?? [];
    const subTools = new ToolRegistry();
    for (const tool of filterToolsForType(parentOpts.tools, type)) subTools.register(tool);
    // Worker prose is surfaced to the user (stamped role:worker), so voice it when a personality
    // is active. Resolved per spawn so a /personality switch mid-session is honoured; "" → neutral.
    const voiced = Boolean(opts.voiceOverlay?.());
    const subRuntime = new AgentRuntime({
      ...parentOpts,
      tools: subTools,
      dispatcher: new ToolDispatcher(subTools),
      checkpoints: wrapRecorder(parentOpts.checkpoints),
      historyStore: undefined,
      log: stampActor(
        protocolOutput
          ? {
              append(input) {
                const payload =
                  input.type === "assistant_message" &&
                  input.payload &&
                  typeof input.payload === "object" &&
                  !Array.isArray(input.payload)
                    ? { ...(input.payload as Record<string, unknown>), internalProtocol: true }
                    : input.payload;
                return parentOpts.log.append({ ...input, payload });
              },
            }
          : parentOpts.log,
        { role: "worker", taskId },
      ),
      pendingTaskTitles: () => pendingTitles ?? [],
      workerOwnedPaths: () => ownedPaths ?? [],
      // Explore workers are intentionally read-only. The edit-based no-progress watchdog and
      // edit-now course correction apply only to general implementation workers.
      workerNoProgressTokens: type === "explore" ? 0 : parentOpts.workerNoProgressTokens,
      workerRequiresEdit: type === "general",
      workerConvergenceFraction: convergeEarly ? 0.75 : undefined,
      systemPrompt: () => subagentSystemPrompt(type, parentOpts.systemPrompt(), voiced),
      smallSystemPrompt: parentOpts.smallSystemPrompt
        ? () => subagentSystemPrompt(type, parentOpts.smallSystemPrompt!(), voiced)
        : undefined,
      triggeredSkillReminders: (input) => {
        const base = opts.workerSkillSeed ? opts.workerSkillSeed(input) : [];
        return [...new Set([...seed, ...base])];
      },
    });
    const convergence = convergeEarly
      ? "\n\nCONVERGENCE RULE: Separate required evidence from optional investigation. Once every required check has decisive current evidence, stop using tools and emit the requested final response immediately. Do not spend remaining budget looking for nicer evidence or additional harnesses. If any check remains unverified, report it as failed with the evidence already available."
      : "";
    return subRuntime.runTurn(
      opts.sessionId,
      `${prompt}${convergence}`,
      signal,
      "orchestration-worker",
      title,
    );
  };
}
