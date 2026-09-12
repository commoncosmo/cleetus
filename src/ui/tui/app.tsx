import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  architectureResolutionPrompt,
  copiedStatefulControllerRisk,
} from "../../agent/architecture-risk";
import {
  extractImageCandidates,
  isRootedPath,
  resolveAttachmentPaths,
  stageImages,
  storeImage,
} from "../../agent/attachments";
import {
  type BootstrapLocation,
  appendLocationAnchor,
  isFreshBootstrap,
  shouldPromptBootstrapLocation,
  suggestSubdirName,
} from "../../agent/bootstrap-location";
import { type EffortLevel, completeEffortLine } from "../../agent/effort";
import {
  type OrchestrationAdmissionReport,
  admissionChoicePayload,
  analyzeOrchestrationAdmission,
} from "../../agent/orchestration-admission";
import type { OrchestrationPlan, Orchestrator } from "../../agent/orchestrator";
import { type PersonalityId, completePersonalityLine } from "../../agent/personalities";
import { type PersonaId, completePersonaLine } from "../../agent/personas";
import { persistPlanArtifact } from "../../agent/plan-artifact";
import {
  PLAN_APPROVAL_MESSAGE,
  approvedPlanStepTitles,
  buildPlanStepPrompt,
  isApprovablePlanResult,
  isPlanCandidateResult,
  looksLikePlanExecutionRequest,
  planRevisionTurnPrompt,
  recoverApprovablePlanContext,
} from "../../agent/plan-mode";
import { buildPromptOptions, offerOrchestrateAfterPlan } from "../../agent/plan-or-go";
import { type RouteMode, completeRouteLine } from "../../agent/route-modes";
import type { AgentRuntime } from "../../agent/runtime";
import type { TurnRoutingHints } from "../../agent/selector";
import {
  buildDirectBuildObjective,
  buildSpecPlanPrompt,
  buildSpecRevisionPrompt,
  composeReviewedSpecPlan,
  matchSpecHandoff,
  resolveSpecExecutionAction,
  specRequiresArchitectureReview,
  writtenSpec,
} from "../../agent/spec-handoff";
import type { TodoSnapshot } from "../../agent/todo-snapshot";
import type { OrchestrationConfig } from "../../config/orchestration";
import type { ResizeConfig } from "../../config/resize";
import type { VisionConfig } from "../../config/vision";
import { listArtifactEditTargets, resolveArtifactEditTarget } from "../../editor/artifacts";
import { type EditorAuditIntegration, runAuditedEditorHandoff } from "../../editor/audit";
import { completeEditorLine } from "../../editor/complete";
import type { EditorLaunchResult } from "../../editor/launch";
import { drainEditorInput } from "../../editor/terminal";
import type { EventLog } from "../../events/log";
import { actorOf } from "../../events/types";
import type { Event } from "../../events/types";
import { sumUsage } from "../../events/usage";
import { addAllowRule, addRule } from "../../permission/grant";
import { type PermissionMode, completeModeLine } from "../../permission/modes";
import { persistRule } from "../../permission/persist";
import type { Decision, PermissionRules } from "../../permission/types";
import { type Catalog, completeModelLine } from "../../providers/catalog";
import type { ProviderRegistry } from "../../providers/registry";
import type { ImageRef } from "../../providers/types";
import { gateVision } from "../../providers/vision";
import { completeSkillLine } from "../../skills/complete";
import type { SkillRegistry } from "../../skills/registry";
import type { CommandRegistry } from "../../slash/commands";
import { completeSlashLine } from "../../slash/complete";
import { parseSlashCommand } from "../../slash/parser";
import type { SlashPresentation } from "../../slash/types";
import type { WorkflowCommandController } from "../../workflows/interactive-controller";
import type { JsonObject, JsonSchema } from "../../workflows/types";
import type { RequestWorkflowAuthorization, WorkflowAuthorizationRequest } from "../cli/workflow";
import { useTheme } from "../theme";
import { BootstrapLocationPrompt } from "./bootstrap-location-prompt";
import { BusyIndicator } from "./busy-indicator";
import { grabClipboardImage } from "./clipboard-image";
import { CommandPanel } from "./command-panel";
import { EditorPermissionPrompt } from "./editor-permission-prompt";
import { EffortPickerModal } from "./effort-picker-modal";
import { FRAME_MS, subscribeFrameClock } from "./frame-clock";
import { History } from "./history";
import { type HistoryModel, advanceHistory, seedHistory, settlePending } from "./history-model";
import { Input, type InputSeed } from "./input";
import { type InputGateFlags, inputDisabled } from "./input-gate";
import { enqueue, queuedLine, resolveBoundary } from "./input-queue";
import { isToggleReasoningKey } from "./keys";
import { ModePickerModal } from "./mode-picker-modal";
import { ModelPickerModal } from "./model-picker-modal";
import { formatModelRoster } from "./model-roster";
import {
  admissionRevisionPlan,
  orchestrationStartTransition,
  structureOrchestrationForApproval,
  structuringFailureRevisionPlan,
} from "./orchestration-start";
import { OrchestrationStructuringStatus } from "./orchestration-structuring-status";
import { type PermissionAction, PermissionPrompt } from "./permission-prompt";
import { PersonaPickerModal } from "./persona-picker-modal";
import { PersonalityPickerModal } from "./personality-picker-modal";
import { PlanApprovalPrompt } from "./plan-approval-prompt";
import { BuildPrompt } from "./plan-or-go-prompt";
import { PlanOrchestratePrompt } from "./plan-orchestrate-prompt";
import { createRenderDebugSink, estimateWrappedLines, renderDebugEnabled } from "./render-debug";
import { RestorePrompt } from "./restore-prompt";
import { RewindPickerModal } from "./rewind-picker-modal";
import type { RewindCheckpoint } from "./rewind-row";
import { RoutePickerModal } from "./route-picker-modal";
import { SessionPickerModal } from "./session-picker-modal";
import type { SessionRow } from "./session-row";
import { SpecDraftPrompt } from "./spec-draft-prompt";
import { type SpecExecutionChoice, SpecExecutionPrompt } from "./spec-execution-prompt";
import { SpecRevisionPrompt } from "./spec-revision-prompt";
import { takeStaged } from "./staged-buffer";
import { stagedIndicator } from "./staged-indicator";
import { StatusBar } from "./status-bar";
import { liveWindowBudget, liveWindowReserve, trackerBudget, wrappedRows } from "./stream-window";
import { type LiveStream, isStreamChunk, reduceLive } from "./streaming";
import { TaskListApprovalPrompt } from "./task-list-approval-prompt";
import {
  EMPTY_TRACKER,
  applyTodos,
  completionReceipt,
  hydrateTracker,
  trackerTodosFrom,
} from "./todo-meter";
import { TodoTracker } from "./todo-tracker";
import { useTerminalRows } from "./use-terminal-rows";
import { WorkflowInputPrompt } from "./workflow-input-prompt";
import { WorkflowPermissionPrompt } from "./workflow-permission-prompt";

export interface AppProps {
  sessionId: string;
  runtime: AgentRuntime;
  log: EventLog;
  commands: CommandRegistry;
  /** Launch an external editor after the TUI has released terminal input. */
  launchEditor: (
    request: {
      args?: string;
      targets?: string[];
      confirmOutsideProject?: boolean;
      create?: boolean;
    },
    cwd: string,
    authorizeOutsideProject: (request: {
      editor: string;
      targets: string[];
    }) => Promise<boolean>,
  ) => Promise<EditorLaunchResult>;
  workflowController?: WorkflowCommandController;
  projectPermissionsPath: string;
  globalPermissionsPath: string;
  /** Live in-memory permission rules; interactive grants update these in place. */
  permissions: PermissionRules;
  cwd: string;
  providers: ProviderRegistry;
  catalog: Catalog;
  skills: SkillRegistry;
  getActive: () => { provider: string; model: string };
  onSelectModel: (provider: string, model: string) => void;
  onSelectMode: (mode: PermissionMode) => void;
  resolverRegister: (fn: ResolveFn) => void;
  workflowAuthorizationRegister: (fn: RequestWorkflowAuthorization) => void;
  workflowInputRegister: (
    fn: (request: { workflow: string; schema: JsonSchema }) => Promise<JsonObject>,
  ) => void;
  modelPickerRegister: (open: () => void) => void;
  modePickerRegister: (open: (initial?: PermissionMode) => void) => void;
  activeDisplayRegister: (set: (next: { provider: string; model: string }) => void) => void;
  modeDisplayRegister: (set: (mode: PermissionMode) => void) => void;
  routeMode: RouteMode;
  routeDisplayRegister: (set: (mode: RouteMode) => void) => void;
  onSelectRoute: (mode: RouteMode) => void;
  routePickerRegister: (open: () => void) => void;
  persona: PersonaId;
  personaDisplayRegister: (set: (id: PersonaId) => void) => void;
  onSelectPersona: (id: PersonaId) => void;
  personaPickerRegister: (open: () => void) => void;
  effort: EffortLevel;
  effortDisplayRegister: (set: (level: EffortLevel) => void) => void;
  onSelectEffort: (level: EffortLevel) => void;
  effortPickerRegister: (open: () => void) => void;
  getCheckpoints: () => RewindCheckpoint[];
  onSelectRewind: (turnNumber: number) => void;
  rewindPickerRegister: (open: () => void) => void;
  /** Resumable sessions (those with a saved snapshot), most-recent first. */
  getResumableSessions?: () => SessionRow[];
  /** Resume the chosen session: load its snapshot into the runtime + re-key the view. */
  onSelectSession?: (id: string) => void;
  /** Open the session picker as an overlay on first render (`--resume` with no id). */
  openSessionPickerOnStart?: boolean;
  personality: PersonalityId;
  personalityDisplayRegister: (set: (id: PersonalityId) => void) => void;
  onSelectPersonality: (id: PersonalityId) => void;
  personalityPickerRegister: (open: () => void) => void;
  tiersConfigured: boolean;
  /** True when in plan mode (read-only gate active). */
  planMode?: boolean;
  /** Called when the user approves a plan (restores the prior permission mode). */
  onApprovePlan: () => void;
  orchestrator: Orchestrator;
  orchestration: OrchestrationConfig;
  orchestrationDisplayRegister: (set: (enabled: boolean) => void) => void;
  getPlanContext: () => { request: string; prosePlan: string };
  /** Absolute project root — used to ground a single-agent bootstrap fallback. */
  projectDir: string;
  /** Configured spec artifact directory, relative to projectDir unless absolute. */
  specsDir: string;
  /** Vision/attachment limits + gating config for `/image` staging and submit-time resolution. */
  vision: VisionConfig;
  /** Resize-on-ingest config forwarded to `storeImage`/`resolveAttachmentPaths`. */
  resize: ResizeConfig;
  /** Hand the TUI's staged-image setter to the `/image` command (bin-side register pattern). */
  stageImagePathsRegister: (fn: (paths: string[]) => Promise<void>) => void;
  /** Hand the TUI's staged-image clearer to the `/image clear` command. */
  clearStagedImagesRegister: (fn: () => void) => void;
  /** Hand the TUI's clipboard-image stager to the bare `/image` command. */
  stageClipboardImageRegister: (fn: () => Promise<void>) => void;
  /** When true, build/create requests get a pre-turn plan-or-go choice (config-gated, default off). */
  planOrGoEnabled?: boolean;
  /** When true (default), stream the model's prose live in the transcript. */
  streamingEnabled?: boolean;
  /** When true (default), render the reasoning channel live + collapsed marker. */
  reasoningEnabled?: boolean;
  /** Show internal diagnostic events that remain hidden during normal runs. */
  verbose?: boolean;
  /** Max visual lines for the live reasoning window (tail-follow); default 10. */
  reasoningLines?: number;
  /** Max visual lines for the live prose window (tail-follow); default 12. */
  proseLines?: number;
  /** True when permissions are disabled (--fuckit or config). */
  fuckit?: boolean;
  /** Open the model picker as an overlay on first render (no model resolved yet). */
  openModelPickerOnStart?: boolean;
  /** Called when the user cancels the startup picker (→ quit). */
  onStartupCancel?: () => void;
  /** An unfinished todo list from a prior session to offer restoring on startup. */
  restoreCandidate?: TodoSnapshot | null;
  /** Restore the candidate list into the current session (seed context + transcript). */
  onRestoreTodos?: (snap: TodoSnapshot) => void;
  /** Dismiss the candidate so it is not offered again. */
  onDismissTodos?: (snap: TodoSnapshot) => void;
  /** List the project dir's top-level entries (sync); used to detect a fresh-bootstrap target
   *  before orchestration structures the plan. */
  listProjectDir?: () => string[];
  /** Active launch scope (global/scratch), shown in the status bar; unset in normal project mode. */
  launchScope?: "global" | "scratch";
}

/** How long the all-complete tracker row is held before it commits its receipt and clears.
 *  The one timed transition in the widget; everything else repaints instantly. */
const COMPLETION_HOLD_MS = 2000;

type OrchestrationOrigin = "spec" | "plan" | "build";
type OrchestrationStartOutcome = "ready" | "failed" | "cancelled" | "location-pending";

export type ResolveFn = (
  request: {
    tool: string;
    argsSummary: string;
    escapes?: boolean;
    targetPath?: string;
    readEscape?: boolean;
  },
  respond: (decision: Decision, grantOutside?: boolean) => void,
) => void;

interface PendingPrompt {
  tool: string;
  argsSummary: string;
  escapes?: boolean;
  targetPath?: string;
  /** Out-of-project READ prompt: [a]/[g] quick-grant a directory-scoped pathPrefix rule
   *  (never a whole-tool allow) via PermissionPrompt's readEscapeQuickGrant path. */
  readEscape?: boolean;
  respond: (decision: Decision, grantOutside?: boolean) => void;
}

interface EditorRequest {
  launch: { args?: string; targets?: string[]; confirmOutsideProject?: boolean; create?: boolean };
  integration: EditorAuditIntegration;
  resolve: () => void;
  reject: (error: Error) => void;
}

function editorIntegration(command: string): EditorAuditIntegration {
  switch (command) {
    case "workflow":
    case "skill":
    case "config":
    case "permissions":
    case "instructions":
    case "spec":
    case "plan":
      return command;
    default:
      return "edit";
  }
}

export function App(props: AppProps) {
  // The active session id is stateful: the startup session picker (--resume, no id) can
  // swap it to a resumed session, which re-keys the event view + subsequent turns.
  const [sessionId, setSessionId] = useState(props.sessionId);
  const [events, setEvents] = useState<Event[]>(() =>
    props.log.query(props.sessionId).filter((e) => !isStreamChunk(e.type)),
  );
  const [historyModel, setHistoryModel] = useState<HistoryModel>(() =>
    seedHistory(
      props.log.query(props.sessionId).filter((e) => !isStreamChunk(e.type)),
      props.reasoningEnabled ?? true,
      props.verbose ?? false,
    ),
  );
  const modelRef = useRef<HistoryModel>(historyModel);
  const [busy, setBusy] = useState(false);
  const t = useTheme();
  // `/image` staging buffer: paths (or a future clipboard grab) attached here wait for the next
  // submitted message, then are merged with any inline @sigil/auto-detected paths and cleared.
  // `stagedImagesRef` mirrors the state so `runPrompt` can snapshot-and-clear it synchronously,
  // before any `await` — otherwise a second same-tick `runPrompt` call (e.g. plan mode's internal
  // architecture-resolution turn, or a step in `executeApprovedPlan`) would read the stale,
  // still-populated state binding from its closure and re-attach the same images.
  const [stagedImages, setStagedImages] = useState<ImageRef[]>([]);
  const stagedImagesRef = useRef<ImageRef[]>([]);
  const setStagedImagesBoth = useCallback(
    (next: ImageRef[] | ((cur: ImageRef[]) => ImageRef[])) => {
      setStagedImages((cur) => {
        const resolved = typeof next === "function" ? next(cur) : next;
        stagedImagesRef.current = resolved;
        return resolved;
      });
    },
    [],
  );
  const attachDir = join(props.projectDir, ".cleetus", "attachments");
  const pushNotice = useCallback(
    (text: string, level: "warn" | "info" = "warn") => {
      props.log.append({ sessionId, type: "notice", payload: { text, level } });
    },
    [props.log, sessionId],
  );
  const stageImagePaths = useCallback(
    async (paths: string[]) => {
      try {
        const resolved = await resolveAttachmentPaths(paths, props.vision, attachDir, props.resize);
        for (const e of resolved.errors) pushNotice(e, "warn");
        for (const w of resolved.warnings) pushNotice(w, "warn");
        setStagedImagesBoth((cur) => stageImages(cur, resolved));
      } catch (e) {
        pushNotice(`could not stage image(s): ${(e as Error).message}`, "warn");
      }
    },
    [props.vision, props.resize, attachDir, pushNotice, setStagedImagesBoth],
  );
  const clearStagedImages = useCallback(() => setStagedImagesBoth([]), [setStagedImagesBoth]);
  const stageClipboardImage = useCallback(async () => {
    try {
      const { bytes, error } = grabClipboardImage();
      if (error || !bytes) {
        pushNotice(error ?? "no clipboard image", "warn");
        return;
      }
      const {
        ref,
        error: storeErr,
        warning,
      } = await storeImage(bytes, props.vision, attachDir, props.resize);
      if (storeErr || !ref) {
        pushNotice(storeErr ?? "could not store clipboard image", "warn");
        return;
      }
      if (warning) pushNotice(warning, "warn");
      setStagedImagesBoth((cur) => stageImages(cur, { refs: [ref] }));
    } catch (e) {
      pushNotice(`could not stage clipboard image: ${(e as Error).message}`, "warn");
    }
  }, [props.vision, props.resize, attachDir, pushNotice, setStagedImagesBoth]);
  // Single-slot input queue (Finding 9): text typed while busy waits here,
  // visibly, until the idle boundary. Ref mirrors state for the Esc handler
  // and boundary effect (same both-pattern as setModeBoth).
  const [queued, setQueued] = useState<string | null>(null);
  const queuedRef = useRef<string | null>(null);
  const setQueuedBoth = useCallback((v: string | null) => {
    queuedRef.current = v;
    setQueued(v);
  }, []);
  const [inputSeed, setInputSeed] = useState<InputSeed | null>(null);
  const seedKeyRef = useRef(0);
  const prefillInput = useCallback((text: string) => {
    seedKeyRef.current += 1;
    setInputSeed({ text, key: seedKeyRef.current });
  }, []);
  // Set when the just-finished turn was aborted; the boundary effect must
  // then pre-fill, never deliver (defensive belt behind the Esc drain).
  const turnAbortedRef = useRef(false);
  // Every busy cycle starts un-aborted; runPrompt's finally marks aborts.
  // All busy-start call sites MUST go through this helper (never call
  // setBusy directly to start a cycle), else a stale abort flag downgrades a
  // later legitimate delivery to prefill.
  const beginBusy = useCallback(() => {
    turnAbortedRef.current = false;
    setBusy(true);
  }, []);
  const drainQueueToInput = useCallback(() => {
    const q = queuedRef.current;
    if (q == null || q === "") return;
    setQueuedBoth(null);
    prefillInput(q);
  }, [prefillInput, setQueuedBoth]);
  const rows = useTerminalRows();
  // Ink's stdout, which is the coalescing frame writer. Cursor toggles must go through it rather
  // than straight to process.stdout, or they can be painted out of order against a buffered frame.
  const { stdout } = useStdout();
  // Opt-in render diagnostics (CLEETUS_RENDER_DEBUG): when a row settles into <Static>, record its
  // estimated height against the terminal viewport. Pairs with the frame-writer's full-clear probe
  // to catch the intermittent duplicate-final-answer bug (a committed row taller than the viewport).
  // No-op when disabled; the seeded baseline is skipped so only in-session commits are logged.
  const renderDebug = useMemo(
    () =>
      createRenderDebugSink(
        resolve(props.cwd, ".cleetus", "render-debug.jsonl"),
        renderDebugEnabled(process.env),
      ),
    [props.cwd],
  );
  const committedSeenRef = useRef(-1);
  useEffect(() => {
    const n = historyModel.committed.length;
    if (committedSeenRef.current < 0 || n < committedSeenRef.current) {
      committedSeenRef.current = n; // baseline on mount / reset on a session swap
      return;
    }
    const width = stdout?.columns ?? 80;
    for (let i = committedSeenRef.current; i < n; i++) {
      const { event } = historyModel.committed[i]!;
      const text = String((event.payload as { text?: string } | null)?.text ?? "");
      renderDebug.log({
        kind: "commit",
        ts: Date.now(),
        termRows: rows,
        rowType: event.type,
        textLen: text.length,
        estLines: estimateWrappedLines(text, width),
        eventId: event.id,
      });
    }
    committedSeenRef.current = n;
  }, [historyModel, rows, stdout, renderDebug]);
  // The session working list, hoisted out of the transcript so the tracker can repaint it every
  // frame. Named lists (todosTitle) and worker lists stay transcript-only — see the writers in
  // the log subscription below.
  const [tracker, setTracker] = useState(() =>
    hydrateTracker(props.runtime.getSessionTodos(props.sessionId), Date.now()),
  );
  const [todosExpanded, setTodosExpanded] = useState(false);
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [workflowPrompt, setWorkflowPrompt] = useState<{
    request: WorkflowAuthorizationRequest;
    resolve: (decision: Awaited<ReturnType<RequestWorkflowAuthorization>>) => void;
  } | null>(null);
  const [workflowInput, setWorkflowInput] = useState<{
    workflow: string;
    schema: JsonSchema;
    resolve: (inputs: JsonObject) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const [editorRequest, setEditorRequest] = useState<EditorRequest | null>(null);
  const [editorPermissionPrompt, setEditorPermissionPrompt] = useState<{
    editor: string;
    targets: string[];
    resolve: (allowed: boolean) => void;
  } | null>(null);
  const editorRequestRef = useRef<EditorRequest | null>(null);
  const editorInFlightRef = useRef<EditorRequest | null>(null);
  const requestEditor = useCallback(
    (
      launch: {
        args?: string;
        targets?: string[];
        confirmOutsideProject?: boolean;
        create?: boolean;
      },
      integration: EditorAuditIntegration = "edit",
    ): Promise<void> => {
      if (editorRequestRef.current) {
        return Promise.reject(new Error("an editor is already open"));
      }
      return new Promise<void>((resolveRequest, rejectRequest) => {
        const request: EditorRequest = {
          launch,
          integration,
          resolve: resolveRequest,
          reject: rejectRequest,
        };
        editorRequestRef.current = request;
        setEditorRequest(request);
      });
    },
    [],
  );
  const [commandOutput, setCommandOutput] = useState<string | null>(null);
  const [specDraftPending, setSpecDraftPending] = useState<{ specPath: string } | null>(null);
  const [specHandoffPending, setSpecHandoffPending] = useState<{ specPath: string } | null>(null);
  const [orchestrationRetryPending, setOrchestrationRetryPending] = useState(false);
  /** Set after `r` on the draft picker: the next submitted line is the revision. Input stays live. */
  const [specRevisionPending, setSpecRevisionPending] = useState<{ specPath: string } | null>(null);
  const [structuringOrchestration, setStructuringOrchestration] = useState(false);
  const structureFailureRef = useRef<{
    origin: OrchestrationOrigin;
    failure: NonNullable<
      Extract<
        Awaited<ReturnType<typeof structureOrchestrationForApproval>>,
        { kind: "failed" }
      >["failure"]
    >;
  } | null>(null);
  const specFlowActiveRef = useRef(false);
  const specRevisionRef = useRef<{ specPath: string } | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(Boolean(props.openModelPickerOnStart));
  const [modePicker, setModePicker] = useState<{ open: boolean; initial?: PermissionMode }>({
    open: false,
  });
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  const [personaPickerOpen, setPersonaPickerOpen] = useState(false);
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const [rewindPickerOpen, setRewindPickerOpen] = useState(false);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(
    Boolean(props.openSessionPickerOnStart),
  );
  const [personalityPickerOpen, setPersonalityPickerOpen] = useState(false);
  // Show the restore prompt on start only when there is no startup model picker;
  // otherwise it opens after the model is chosen (see handleModelSelect).
  const [restoreOpen, setRestoreOpen] = useState(
    Boolean(props.restoreCandidate) && !props.openModelPickerOnStart,
  );
  const [mode, setMode] = useState<PermissionMode>(
    props.planMode ? "plan" : props.fuckit ? "fuckit" : "normal",
  );
  const modeRef = useRef<PermissionMode>(mode);
  const setModeBoth = useCallback((m: PermissionMode) => {
    modeRef.current = m;
    setMode(m);
  }, []);
  const [history, setHistory] = useState<string[]>(() =>
    props.log
      .query(props.sessionId)
      // Only real user prompts are recallable; exclude down-passed worker/subagent inputs (#152).
      .filter(
        (e) =>
          (e.type === "user_input" || e.type === "workflow_command") && actorOf(e).role === "agent",
      )
      .map((e) => (e.payload as { text: string }).text),
  );
  const [activeDisplay, setActiveDisplay] = useState(() => props.getActive());
  const [routeMode, setRouteMode] = useState<RouteMode>(props.routeMode);
  const [persona, setPersona] = useState<PersonaId>(props.persona);
  const [effort, setEffort] = useState<EffortLevel>(props.effort);
  const [personality, setPersonality] = useState<PersonalityId>(props.personality);
  const [planApprovalPending, setPlanApprovalPending] = useState(false);
  const [planOrchestratePending, setPlanOrchestratePending] = useState(false);
  const [taskListPending, setTaskListPending] = useState<{
    admission: OrchestrationAdmissionReport;
    singleFallback: string;
    request: string;
    prosePlan: string;
    location: BootstrapLocation;
    origin: OrchestrationOrigin;
    revisionAttempts: number;
  } | null>(null);
  const pendingPlanRef = useRef<OrchestrationPlan | null>(null);
  const approvedPlanContextRef = useRef<{
    request: string;
    prosePlan: string;
    /** Step titles parsed from the review at approval time, so the stepwise executor names exact
     * steps (parsing the composed spec+review later can over-match spec-section numbering). */
    steps?: string[];
  } | null>(null);
  const latestPlanPathRef = useRef<string | null>(null);
  const pendingPlanRevisionRef = useRef<{
    context: { request: string; approvedSpec?: { path: string; body: string } };
    optionsOffered: boolean;
  } | null>(null);
  const [bootstrapLocationPending, setBootstrapLocationPending] = useState<{
    suggestedName: string;
  } | null>(null);
  const bootstrapStashRef = useRef<
    | {
        kind: "orchestrate";
        request: string;
        prosePlan: string;
        singleFallback: string;
        origin: OrchestrationOrigin;
      }
    | { kind: "single"; text: string }
    | null
  >(null);
  const [buildPromptPending, setBuildPromptPending] = useState<{
    text: string;
    showOrchestrate: boolean;
  } | null>(null);
  const [orchestrationEnabled, setOrchestrationEnabled] = useState(props.orchestration.enabled);
  const orchestrationEnabledRef = useRef(orchestrationEnabled);
  const setOrchestrationBoth = useCallback((v: boolean) => {
    orchestrationEnabledRef.current = v;
    setOrchestrationEnabled(v);
  }, []);
  const tokens = useMemo(() => sumUsage(events), [events]);
  const lastTier = useMemo<"small" | "large" | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type === "model_call_start") {
        const t = (events[i]!.payload as { tier?: "small" | "large" | null }).tier;
        // null = manual call (no tier); undefined = pre-routing event with no tier key → keep scanning.
        if (t !== undefined) return t;
      }
    }
    return null;
  }, [events]);
  const project = basename(props.cwd) || props.cwd;
  const promptRef = useRef<PendingPrompt | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // True while the open model picker is the startup one (cancel → quit, not just close).
  const startupPickerRef = useRef(Boolean(props.openModelPickerOnStart));
  // Live streaming buffer: high-frequency chunk events fold into this ref (no re-render) and
  // are flushed to `liveStream` state on a throttled tick so a chunk flood can't saturate the
  // event loop (which would starve Ink's ESC/CTRL+C input handler).
  const liveRef = useRef<LiveStream>({ callId: null, reasoning: "", prose: "" });
  const liveDirtyRef = useRef(false);
  const [liveStream, setLiveStream] = useState<LiveStream>(liveRef.current);
  // The live tail starts collapsed for every model call; Ctrl+R expands it for the active call.
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const reasoningCallRef = useRef<string | null>(liveRef.current.callId);

  useEffect(() => {
    if (liveStream.callId === reasoningCallRef.current) return;
    reasoningCallRef.current = liveStream.callId;
    setReasoningExpanded(false);
  }, [liveStream.callId]);

  // The editor starts from a passive effect so React first commits the render
  // that unmounts Input. That releases Ink's raw-mode listener before the child
  // inherits stdin/stdout/stderr.
  useEffect(() => {
    if (!editorRequest || editorInFlightRef.current === editorRequest) return;
    editorInFlightRef.current = editorRequest;
    let error: Error | null = null;
    void (async () => {
      (stdout ?? process.stdout).write("\u001B[?25h");
      try {
        await runAuditedEditorHandoff({
          integration: editorRequest.integration,
          request: editorRequest.launch,
          cwd: props.cwd,
          launch: props.launchEditor,
          authorizeOutsideProject: (request) =>
            new Promise<boolean>((resolveApproval) => {
              setEditorPermissionPrompt({ ...request, resolve: resolveApproval });
            }),
          record: (payload) => {
            props.log.append({
              sessionId,
              type: "editor_audit",
              payload,
            });
          },
        });
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      } finally {
        // Vim and other terminal editors can leave replies to cursor/color
        // queries unread as they exit. Consume them while Input is still
        // unmounted so Ink cannot insert those bytes into the next prompt.
        await drainEditorInput(process.stdin);
        (stdout ?? process.stdout).write("\u001B[?25l");
        editorInFlightRef.current = null;
        if (editorRequestRef.current === editorRequest) {
          editorRequestRef.current = null;
          setEditorRequest(null);
        }
        // Let the input remount and repaint before the slash command completes.
        await new Promise<void>((resolveTick) => setImmediate(resolveTick));
        if (error) editorRequest.reject(error);
        else editorRequest.resolve();
      }
    })();
  }, [editorRequest, props.cwd, props.launchEditor, props.log, sessionId, stdout]);

  // While a turn is in flight (and no prompt is awaiting input), Escape cancels it.
  // The queued slot drains into the input buffer BEFORE the abort: after Esc the
  // message sits pre-filled, editable, unsent — one Enter re-sends (FINDINGS F9).
  useInput(
    (_input, key) => {
      if (key.escape) {
        drainQueueToInput();
        abortRef.current?.abort();
      }
    },
    {
      isActive: busy && !editorRequest && !prompt && !workflowPrompt && !workflowInput,
    },
  );

  useEffect(() => {
    // Re-seed from the (possibly swapped) session's persisted events (excluding high-frequency
    // chunk events — they feed the live buffer, not the row list), then subscribe.
    const seedEvents = props.log.query(sessionId).filter((e) => !isStreamChunk(e.type));
    setEvents(seedEvents);
    // Settle the seeded model so a resumed/forked session's trailing answer starts in <Static>,
    // not full-height in the dynamic region where it would trip Ink's clearTerminal branch (see
    // settlePending). In-flight rows from an interrupted session stay pending.
    modelRef.current = settlePending(
      seedHistory(seedEvents, props.reasoningEnabled ?? true, props.verbose ?? false),
    );
    setHistoryModel(modelRef.current);
    liveRef.current = { callId: null, reasoning: "", prose: "" };
    liveDirtyRef.current = false;
    setLiveStream(liveRef.current);
    // The runtime snapshot is loaded before `sessionId` changes. Hydrate from that snapshot so a
    // resumed/swapped session shows its unfinished list immediately instead of waiting for the
    // model to issue another todo_write.
    setTracker(hydrateTracker(props.runtime.getSessionTodos(sessionId), Date.now()));
    const unsub = props.log.subscribe(sessionId, (e) => {
      if (isStreamChunk(e.type)) {
        // High-frequency: fold into the buffer (O(1)); the throttle tick flushes it.
        liveRef.current = reduceLive(liveRef.current, e);
        liveDirtyRef.current = true;
      } else {
        // Structural/terminal: update rows + buffer, and flush immediately so committed
        // messages and call boundaries never lag a tick.
        liveRef.current = reduceLive(liveRef.current, e);
        setEvents((prev) => [...prev, e]);
        modelRef.current = advanceHistory(modelRef.current, e);
        setHistoryModel(modelRef.current);
        liveDirtyRef.current = false;
        setLiveStream(liveRef.current);
        const todos = trackerTodosFrom(e);
        if (todos) setTracker((prev) => applyTodos(prev, todos, Date.now()));
      }
    });
    return unsub;
  }, [props.log, props.runtime.getSessionTodos, sessionId, props.reasoningEnabled, props.verbose]);

  // Flush the live streaming buffer to state at a bounded rate so a flood of chunks cannot
  // saturate the event loop (which would starve Ink's ESC/CTRL+C input handler). On the shared
  // frame clock, so a streaming turn produces one frame per tick rather than beating against the
  // spinner and the elapsed clock.
  useEffect(() => {
    if (!busy) return;
    return subscribeFrameClock(FRAME_MS, () => {
      if (liveDirtyRef.current) {
        liveDirtyRef.current = false;
        setLiveStream(liveRef.current);
      }
    });
  }, [busy]);

  // When a turn goes idle, settle finished rows out of the dynamic region into <Static>. The
  // per-event reducer settles finals at the next step boundary, but a turn's LAST answer has no
  // following event — left full-height in `pending` on a short terminal it trips Ink's clearTerminal
  // branch and duplicates into scrollback (the "duplicate final answer" bug). settlePending returns
  // the same reference when nothing settles, so this is a no-op re-render on an already-idle model.
  useEffect(() => {
    if (busy) return;
    const settled = settlePending(modelRef.current);
    if (settled !== modelRef.current) {
      modelRef.current = settled;
      setHistoryModel(settled);
    }
  }, [busy]);

  useEffect(() => {
    props.resolverRegister((request, respond) => {
      const p = { ...request, respond };
      promptRef.current = p;
      setPrompt(p);
    });
    props.workflowAuthorizationRegister(
      (request) =>
        new Promise((resolve) => {
          setWorkflowPrompt({ request, resolve });
        }),
    );
    props.workflowInputRegister(
      (request) =>
        new Promise((resolve, reject) => {
          const required = new Set((request.schema.required ?? []) as string[]);
          const properties = (request.schema.properties ?? {}) as Record<string, JsonSchema>;
          const missing = Object.entries(properties).some(
            ([name, property]) => required.has(name) && !Object.hasOwn(property, "default"),
          );
          if (!missing) resolve({});
          else setWorkflowInput({ ...request, resolve, reject });
        }),
    );
    props.modelPickerRegister(() => setModelPickerOpen(true));
    props.modePickerRegister((initial) => setModePicker({ open: true, initial }));
    props.activeDisplayRegister(setActiveDisplay);
    props.modeDisplayRegister(setModeBoth);
    props.routeDisplayRegister(setRouteMode);
    props.routePickerRegister(() => setRoutePickerOpen(true));
    props.personaDisplayRegister(setPersona);
    props.personaPickerRegister(() => setPersonaPickerOpen(true));
    props.effortDisplayRegister(setEffort);
    props.effortPickerRegister(() => setEffortPickerOpen(true));
    props.rewindPickerRegister(() => setRewindPickerOpen(true));
    props.personalityDisplayRegister(setPersonality);
    // (session picker has no slash command; it is startup-only via openSessionPickerOnStart)
    props.personalityPickerRegister(() => setPersonalityPickerOpen(true));
    props.orchestrationDisplayRegister(setOrchestrationBoth);
    props.stageImagePathsRegister(stageImagePaths);
    props.clearStagedImagesRegister(clearStagedImages);
    props.stageClipboardImageRegister(stageClipboardImage);
  }, [
    props,
    setModeBoth,
    setOrchestrationBoth,
    stageImagePaths,
    clearStagedImages,
    stageClipboardImage,
  ]);

  async function runPrompt(
    text: string,
    location?: BootstrapLocation,
    routingHints?: TurnRoutingHints,
  ) {
    // Capture the host's workflow before awaiting attachments or model calls. Follow-up answers
    // and revision prompts have no /spec prefix, but belong to the same drafting dialogue.
    const specTurn = routingHints?.specTurn ?? specFlowActiveRef.current;
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const turnText = location ? appendLocationAnchor(text, location, props.projectDir) : text;

      // Attachments: the `/image` staging buffer plus inline `@`-sigil and auto-detected image
      // paths from this turn's text. Sigil paths are explicit — their resolution errors are
      // surfaced as notices. Auto-detected paths are split by how confident we are that the
      // user meant a real file: rooted paths (absolute, `~/`, `./`, `../`) are a strong signal,
      // so their errors are surfaced too; loose bare filenames stay silent since a token that
      // isn't really an image just stays prose. Each `resolveAttachmentPaths` batch independently
      // caps at vision.maxPerTurn, so the merge can exceed it — truncate to the cap as a final
      // backstop.
      //
      // Snapshot-and-clear the staged buffer synchronously, before any `await`, so a second
      // `runPrompt` call inside the same submit (e.g. plan mode's internal architecture-resolution
      // turn, or a step in `executeApprovedPlan`) reads an empty buffer instead of re-reading the
      // stale, still-populated closure and re-attaching the same images to a turn they were never
      // meant for.
      const turnStaged = takeStaged(stagedImagesRef);
      setStagedImages([]);

      const { sigilPaths, autoPaths } = extractImageCandidates(text);
      const sigil = await resolveAttachmentPaths(sigilPaths, props.vision, attachDir, props.resize);
      const rootedAuto = await resolveAttachmentPaths(
        autoPaths.filter(isRootedPath),
        props.vision,
        attachDir,
        props.resize,
      );
      const looseAuto = await resolveAttachmentPaths(
        autoPaths.filter((p) => !isRootedPath(p)),
        props.vision,
        attachDir,
        props.resize,
      );
      for (const e of [...sigil.errors, ...rootedAuto.errors]) pushNotice(e, "warn");
      for (const w of [...sigil.warnings, ...rootedAuto.warnings, ...looseAuto.warnings]) {
        pushNotice(w, "warn");
      }
      let turnImages = stageImages(
        stageImages(stageImages(turnStaged, sigil), rootedAuto),
        looseAuto,
      );
      if (turnImages.length > props.vision.maxPerTurn) {
        pushNotice(
          `${turnImages.length} images exceeded the per-turn cap of ${props.vision.maxPerTurn}; attaching the first ${props.vision.maxPerTurn}`,
          "warn",
        );
        turnImages = turnImages.slice(0, props.vision.maxPerTurn);
      }
      if (turnImages.length > 0) {
        const active = props.getActive();
        const support =
          (await props.providers.get(active.provider).supportsVision?.(active.model)) ?? "unknown";
        const gate = gateVision(support, active.model, props.vision);
        if (gate.action === "block") {
          pushNotice(gate.message ?? "the active model can't view images", "warn");
          throw new Error(gate.message ?? "vision blocked");
        }
        if (gate.action === "warn") pushNotice(gate.message ?? "sending images anyway", "warn");
      }

      const res = await props.runtime.runTurn(
        sessionId,
        turnText,
        ac.signal,
        undefined,
        undefined,
        turnImages.length > 0 ? turnImages : undefined,
        { ...routingHints, specTurn },
      );
      const hit = matchSpecHandoff(res.assistantText);
      const revision = specRevisionRef.current;
      if (revision) {
        specRevisionRef.current = null;
        specFlowActiveRef.current = false;
        if (res.stoppedReason) {
          setSpecDraftPending(revision);
          setCommandOutput("The spec revision did not finish. The draft remains pending review.");
        } else {
          // A completed revision returns to the draft picker; the user may revise again, edit,
          // save, or approve — approval is what opens the execution chooser.
          setSpecDraftPending(writtenSpec(res) ?? hit ?? revision);
        }
      } else if (specFlowActiveRef.current) {
        const draft = writtenSpec(res) ?? hit;
        if (draft) {
          specFlowActiveRef.current = false;
          setSpecHandoffPending(null);
          setSpecDraftPending(draft);
        }
      } else if (hit && !specRevisionPending) {
        // A handoff detected while the user is typing a revision (e.g. a slash-run turn) must not
        // stack a second checkpoint underneath the revision prompt.
        setSpecHandoffPending(hit);
      }
      return res;
    } finally {
      if (ac.signal.aborted) turnAbortedRef.current = true;
      abortRef.current = null;
    }
  }

  async function runTurnAndMaybePromptApproval(
    text: string,
    planContext?: { request: string; approvedSpec?: { path: string; body: string } },
  ) {
    setPlanApprovalPending(false);
    const turnText =
      !planContext && pendingPlanRevisionRef.current ? planRevisionTurnPrompt(text) : text;
    const specReview = Boolean(
      (planContext ?? pendingPlanRevisionRef.current?.context)?.approvedSpec,
    );
    const result = await runPrompt(turnText, undefined, {
      specTurn: specReview || specFlowActiveRef.current,
      userRequest: planContext ? null : text,
    });
    const planCandidate = modeRef.current === "plan" && isPlanCandidateResult(result);
    const architectureRisk = planCandidate
      ? copiedStatefulControllerRisk(result.assistantText)
      : null;
    if (planCandidate && architectureRisk) {
      approvedPlanContextRef.current = null;
      // An explicit context starts a fresh review. A user reply without one continues the current
      // repair dialogue and must not trigger a second automatic options turn.
      const priorRevision = planContext ? null : pendingPlanRevisionRef.current;
      const revisionContext = planContext ?? priorRevision?.context ?? { request: text };
      const shouldOfferOptions = priorRevision?.optionsOffered !== true;
      pendingPlanRevisionRef.current = {
        context: revisionContext,
        optionsOffered: true,
      };
      props.log.append({
        sessionId,
        type: "notice",
        payload: {
          text: `Plan needs revision before approval: ${architectureRisk}`,
          level: "warn",
          kind: "plan_architecture_risk",
        },
      });
      setCommandOutput(`Plan needs revision before approval: ${architectureRisk}`);
      if (shouldOfferOptions) {
        props.log.append({
          sessionId,
          type: "notice",
          payload: {
            text: "Architecture conflict found; presenting repair options and a recommendation.",
            level: "info",
            kind: "plan_architecture_resolution",
          },
        });
        await runPrompt(
          architectureResolutionPrompt(architectureRisk),
          undefined,
          specReview ? { specTurn: true } : undefined,
        );
      }
    } else if (modeRef.current === "plan" && isApprovablePlanResult(result)) {
      const effectiveContext = planContext ?? pendingPlanRevisionRef.current?.context;
      pendingPlanRevisionRef.current = null;
      const prosePlan = effectiveContext?.approvedSpec
        ? composeReviewedSpecPlan(
            effectiveContext.approvedSpec.path,
            effectiveContext.approvedSpec.body,
            result.assistantText,
          )
        : result.assistantText;
      approvedPlanContextRef.current = {
        request: effectiveContext?.request ?? text,
        prosePlan,
        // Parse steps from the review itself (result.assistantText), matching how the runtime reads
        // the approved plan, so the stepwise executor gets the review's ordered steps.
        steps: approvedPlanStepTitles(result.assistantText),
      };
      structureFailureRef.current = null;
      try {
        const path = await persistPlanArtifact({
          projectDir: props.projectDir,
          sessionId,
          plan: result.assistantText,
        });
        latestPlanPathRef.current = path;
        props.log.append({
          sessionId,
          type: "notice",
          payload: { text: `plan saved to ${path}`, level: "info" },
        });
      } catch (error) {
        props.log.append({
          sessionId,
          type: "notice",
          payload: {
            text: `could not persist plan artifact: ${error instanceof Error ? error.message : String(error)}`,
            level: "warn",
          },
        });
      }
      setPlanApprovalPending(true);
    } else if (modeRef.current === "plan") {
      approvedPlanContextRef.current = null;
      // Explanations, questions, and resolution-option menus are not replacement plans. Preserve
      // the rejected plan's original request/spec context for the eventual full revision.
    }
    return result;
  }

  async function maybePromptLocationThenRun(text: string) {
    const entries = props.listProjectDir?.() ?? [];
    if (shouldPromptBootstrapLocation({ mode: modeRef.current, text, entries })) {
      bootstrapStashRef.current = { kind: "single", text };
      setBootstrapLocationPending({ suggestedName: suggestSubdirName(text) });
      return;
    }
    await runTurnAndMaybePromptApproval(text);
  }

  async function runStructureAndTaskList(
    request: string,
    prosePlan: string,
    location: BootstrapLocation,
    singleFallback: string,
    origin: OrchestrationOrigin,
    revisionAttempts = 0,
  ): Promise<Exclude<OrchestrationStartOutcome, "location-pending">> {
    beginBusy();
    setStructuringOrchestration(true);
    setOrchestrationRetryPending(false);
    const ac = new AbortController();
    abortRef.current = ac;
    props.log.append({
      sessionId,
      type: "notice",
      payload: {
        text: "Structuring orchestration plan. No workers have started yet.",
        kind: "orchestration_structure",
        status: "started",
      },
    });
    try {
      const structured = await structureOrchestrationForApproval(props.orchestrator, {
        request,
        prosePlan,
        location,
        signal: ac.signal,
      });
      if (structured.kind !== "ready") {
        if (structured.kind === "failed" && structured.failure) {
          structureFailureRef.current = { origin, failure: structured.failure };
        }
        props.log.append({
          sessionId,
          type: "notice",
          payload: {
            text:
              structured.kind === "cancelled"
                ? "Orchestration structuring was cancelled. No workers started."
                : "Orchestration structuring failed. No workers started; the execution choice remains open.",
            level: structured.kind === "failed" ? "warn" : "info",
            kind: "orchestration_structure",
            status: structured.kind,
          },
        });
        return structured.kind;
      }
      const { plan } = structured;
      structureFailureRef.current = null;
      const admission = await analyzeOrchestrationAdmission({ plan, projectDir: props.projectDir });
      if (ac.signal.aborted) {
        props.log.append({
          sessionId,
          type: "notice",
          payload: {
            text: "Orchestration admission was cancelled. No workers started.",
            kind: "orchestration_structure",
            status: "cancelled",
          },
        });
        return "cancelled";
      }
      pendingPlanRef.current = plan;
      setTaskListPending({
        admission,
        singleFallback,
        request,
        prosePlan,
        location,
        origin,
        revisionAttempts,
      });
      props.log.append({
        sessionId,
        type: "notice",
        payload: {
          text: `Orchestration task list ready for approval (${plan.tasks.length} task(s)). No workers have started yet.`,
          kind: "orchestration_structure",
          status: "ready",
          taskCount: plan.tasks.length,
        },
      });
      return "ready";
    } catch (error) {
      props.log.append({
        sessionId,
        type: "notice",
        payload: {
          text: `Orchestration admission failed: ${error instanceof Error ? error.message : String(error)}. No workers started; the execution choice remains open.`,
          level: "warn",
          kind: "orchestration_structure",
          status: "failed",
        },
      });
      return "failed";
    } finally {
      if (ac.signal.aborted) turnAbortedRef.current = true;
      abortRef.current = null;
      setStructuringOrchestration(false);
      setBusy(false);
    }
  }

  function settleOrchestrationStart(
    origin: OrchestrationOrigin,
    outcome: Exclude<OrchestrationStartOutcome, "location-pending">,
  ) {
    const transition = orchestrationStartTransition(outcome);
    if (outcome === "ready") {
      setOrchestrationRetryPending(false);
      return;
    }
    setOrchestrationRetryPending(transition.retry);
    const retryChoices =
      origin === "plan"
        ? "choose `repair`/`r` for a guided decomposition repair, `go`, or `cancel`."
        : origin === "build"
          ? "choose `repair`/`r` for a guided decomposition repair, `plan`, `go`, or `cancel`."
          : "choose `repair`/`r` for a guided decomposition repair, `plan`, `go`, or `cancel`.";
    setCommandOutput(
      outcome === "failed"
        ? `Orchestration did not start. The execution choice is still open; ${retryChoices}`
        : "Orchestration was cancelled before workers started. The execution choice remains open.",
    );
  }

  async function startOrchestration(
    request: string,
    prosePlan: string,
    singleFallback: string,
    origin: OrchestrationOrigin,
  ): Promise<OrchestrationStartOutcome> {
    const priorFailure = structureFailureRef.current;
    const effectiveProsePlan =
      priorFailure?.origin === origin
        ? structuringFailureRevisionPlan(prosePlan, priorFailure.failure)
        : prosePlan;
    structureFailureRef.current = null;
    const entries = props.listProjectDir?.() ?? [];
    if (isFreshBootstrap(entries)) {
      bootstrapStashRef.current = {
        kind: "orchestrate",
        request,
        prosePlan: effectiveProsePlan,
        singleFallback,
        origin,
      };
      setBootstrapLocationPending({ suggestedName: suggestSubdirName(request) });
      return "location-pending";
    }
    const outcome = await runStructureAndTaskList(
      request,
      effectiveProsePlan,
      { kind: "cwd" },
      singleFallback,
      origin,
    );
    settleOrchestrationStart(origin, outcome);
    return outcome;
  }

  async function resolveBootstrapLocation(location: BootstrapLocation) {
    const stash = bootstrapStashRef.current;
    bootstrapStashRef.current = null;
    setBootstrapLocationPending(null);
    if (!stash) return;
    if (stash.kind === "orchestrate") {
      const outcome = await runStructureAndTaskList(
        stash.request,
        stash.prosePlan,
        location,
        stash.singleFallback,
        stash.origin,
      );
      settleOrchestrationStart(stash.origin, outcome);
      return;
    }
    beginBusy();
    try {
      await runPrompt(stash.text, location); // single-agent, grounded
    } catch {
      // The runtime records turn failures in the transcript. This picker callback
      // is fire-and-forget, so contain them here just as handleSubmit does.
    } finally {
      setBusy(false);
    }
  }

  async function approveTaskList() {
    const plan = pendingPlanRef.current;
    const pending = taskListPending;
    setTaskListPending(null);
    pendingPlanRef.current = null;
    if (!plan || !pending) return;
    commitExecutionCheckpoint(pending.origin);
    recordAdmissionChoice(pending.admission, "workers");
    beginBusy();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await props.orchestrator.execute(plan, ac.signal);
    } catch {
      // errors recorded as events
    } finally {
      if (ac.signal.aborted) turnAbortedRef.current = true;
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function runSingleFromTaskList() {
    const pending = taskListPending;
    const plan = pendingPlanRef.current;
    setTaskListPending(null);
    pendingPlanRef.current = null;
    if (!pending || !plan) return;
    commitExecutionCheckpoint(pending.origin);
    recordAdmissionChoice(pending.admission, "single");
    beginBusy();
    try {
      await runPrompt(pending.singleFallback, plan.location);
    } catch {
      // Errors are recorded as events.
    } finally {
      setBusy(false);
    }
  }

  function commitExecutionCheckpoint(origin: OrchestrationOrigin) {
    structureFailureRef.current = null;
    if (origin === "spec") setSpecHandoffPending(null);
    if (origin === "plan") {
      setPlanOrchestratePending(false);
      approvedPlanContextRef.current = null;
    }
    if (origin === "build") setBuildPromptPending(null);
    setOrchestrationRetryPending(false);
  }

  function dismissTaskList() {
    structureFailureRef.current = null;
    setTaskListPending(null);
    pendingPlanRef.current = null;
    setOrchestrationRetryPending(false);
    setCommandOutput(
      "Orchestration task list cancelled. No workers started; the execution choice remains open.",
    );
  }

  async function reviseTaskList() {
    structureFailureRef.current = null;
    const pending = taskListPending;
    if (!pending || pending.revisionAttempts >= 1) return;
    setTaskListPending(null);
    pendingPlanRef.current = null;
    props.log.append({
      sessionId,
      type: "notice",
      payload: {
        text: "Revising the orchestration decomposition once using admission feedback. No workers have started yet.",
        kind: "orchestration_admission_revision",
        status: "started",
        strategy: pending.admission.strategy,
        risks: pending.admission.risks,
      },
    });
    const outcome = await runStructureAndTaskList(
      pending.request,
      admissionRevisionPlan(pending.prosePlan, pending.admission),
      pending.location,
      pending.singleFallback,
      pending.origin,
      pending.revisionAttempts + 1,
    );
    settleOrchestrationStart(pending.origin, outcome);
  }

  function recordAdmissionChoice(
    admission: OrchestrationAdmissionReport,
    choice: "single" | "workers",
  ) {
    props.log.append({
      sessionId,
      type: "notice",
      payload: admissionChoicePayload(admission, choice),
    });
  }

  /** Execute an approved plan one step per bounded turn. Each step runs in the same session against
   * the on-disk code (the shared source of truth), so context stays small and coherent instead of a
   * single turn holding the whole plan until compaction degrades it. A step that stops (thrash,
   * premature) ends the run with the earlier, working steps already delivered. Falls back to a
   * single approval turn when the plan has fewer than two parsed steps. */
  async function executeApprovedPlan() {
    const ctx = approvedPlanContextRef.current;
    const steps = ctx?.steps?.length ? ctx.steps : ctx ? approvedPlanStepTitles(ctx.prosePlan) : [];
    if (!ctx || steps.length < 2) {
      await runTurnAndMaybePromptApproval(PLAN_APPROVAL_MESSAGE);
      return;
    }
    const completedEvidence: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      props.log.append({
        sessionId,
        type: "notice",
        payload: {
          text: `Implementing plan step ${i + 1} of ${steps.length}: ${steps[i]}`,
          level: "info",
          kind: "plan_step",
        },
      });
      const result = await runPrompt(buildPlanStepPrompt(ctx.prosePlan, steps, i), undefined, {
        isolatedPlanStep: true,
        completedStepEvidence: completedEvidence.join("\n"),
      });
      completedEvidence.push(
        `Step ${i + 1}: ${steps[i]}; files: ${result.editedPaths.join(", ") || "none"}; checks: ${(result.verificationResults ?? []).map((check) => `${check.command}: ${check.ok ? "passed" : "failed"}`).join("; ") || "unverified"}`,
      );
      const failedChecks = (result.verificationResults ?? []).filter(
        (check) => !check.ok && !check.baseline,
      );
      if (result.stoppedReason || failedChecks.length > 0) {
        props.log.append({
          sessionId,
          type: "notice",
          payload: {
            text: `Stopped at plan step ${i + 1} of ${steps.length} (${result.stoppedReason ?? "verification failed"}); the steps completed before it were delivered. Use /rewind to restore the last working step if this one left the app broken.`,
            level: "warn",
            kind: "plan_step_stopped",
          },
        });
        break;
      }
    }
  }

  async function handleApprovePlan() {
    if (!approvedPlanContextRef.current) {
      setPlanApprovalPending(false);
      setCommandOutput(
        "No valid implementation plan is ready to approve. Continue planning first.",
      );
      return;
    }
    setPlanApprovalPending(false);
    props.onApprovePlan(); // bin restores prior mode → modeDisplayRegister updates mode/modeRef
    // The plan is approved (we always leave plan mode). If orchestration is enabled, ask who
    // implements it — orchestrate the plan or just go on the chat model — instead of assuming.
    if (offerOrchestrateAfterPlan(orchestrationEnabledRef.current)) {
      setPlanOrchestratePending(true);
      return;
    }
    beginBusy();
    try {
      await executeApprovedPlan();
    } catch {
      // Errors are recorded as `error`/`notice` events; nothing to surface here.
    } finally {
      approvedPlanContextRef.current = null;
      setBusy(false);
    }
  }

  async function recoverApprovedPlanFromHistory(): Promise<boolean> {
    if (approvedPlanContextRef.current) return true;
    const recovered = recoverApprovablePlanContext(props.getPlanContext());
    if (!recovered) return false;
    approvedPlanContextRef.current = recovered;
    try {
      const path = await persistPlanArtifact({
        projectDir: props.projectDir,
        sessionId,
        plan: recovered.prosePlan,
      });
      latestPlanPathRef.current = path;
      props.log.append({
        sessionId,
        type: "notice",
        payload: {
          text: `recovered approved plan from session history; plan saved to ${path}`,
          level: "info",
          kind: "plan_approval_recovered",
        },
      });
    } catch (error) {
      props.log.append({
        sessionId,
        type: "notice",
        payload: {
          text: `recovered approved plan from session history but could not persist it: ${error instanceof Error ? error.message : String(error)}`,
          level: "warn",
          kind: "plan_approval_recovered",
        },
      });
    }
    return true;
  }

  async function runPlanOrchestrateChoice(choice: "orchestrate" | "go", repair = false) {
    if (choice === "orchestrate") {
      if (!repair) structureFailureRef.current = null;
      const { request, prosePlan } = approvedPlanContextRef.current ?? props.getPlanContext();
      await startOrchestration(request, prosePlan, PLAN_APPROVAL_MESSAGE, "plan");
      return;
    }
    setPlanOrchestratePending(false);
    setOrchestrationRetryPending(false);
    structureFailureRef.current = null;
    beginBusy();
    try {
      await executeApprovedPlan();
    } catch {
      // Errors are recorded as `error`/`notice` events; nothing to surface here.
    } finally {
      approvedPlanContextRef.current = null;
      setBusy(false);
    }
  }

  function cancelPlanOrchestrate() {
    approvedPlanContextRef.current = null;
    setPlanOrchestratePending(false); // leave the plan un-implemented; no turn, no mode change
    setOrchestrationRetryPending(false);
    structureFailureRef.current = null;
  }

  async function runBuildPromptChoice(choice: "orchestrate" | "plan" | "go", repair = false) {
    const pending = buildPromptPending;
    if (!pending) return;
    if (choice === "orchestrate") {
      if (!repair) structureFailureRef.current = null;
      await startOrchestration(pending.text, "", pending.text, "build");
      return;
    }
    setBuildPromptPending(null);
    setOrchestrationRetryPending(false);
    structureFailureRef.current = null;
    beginBusy();
    try {
      // "plan first" flips into plan mode for this one turn; setModeBoth updates
      // modeRef.current synchronously, so the post-turn approval check sees "plan".
      if (choice === "plan") props.onSelectMode("plan");
      await maybePromptLocationThenRun(pending.text);
    } catch {
      // Turn errors are recorded as `error` events by the runtime (same as handleSubmit).
    } finally {
      setBusy(false);
    }
  }

  function cancelBuildPrompt() {
    setBuildPromptPending(null); // abandon the message; no turn, no mode change
    setOrchestrationRetryPending(false);
    structureFailureRef.current = null;
  }

  function submitOrQueue(value: string) {
    if (!value.trim()) return;
    if (busy) {
      setQueuedBoth(enqueue(queuedRef.current, value));
      return;
    }
    void handleSubmit(value);
  }

  async function editDurableArtifact(kind: "spec" | "plan", requested: string): Promise<string> {
    const current =
      kind === "spec"
        ? (specDraftPending?.specPath ??
          specHandoffPending?.specPath ??
          specRevisionPending?.specPath ??
          specRevisionRef.current?.specPath)
        : (latestPlanPathRef.current ?? undefined);
    const target = resolveArtifactEditTarget({
      kind,
      projectDir: props.projectDir,
      specsDir: props.specsDir,
      requested: requested || undefined,
      current,
    });
    await requestEditor({ targets: [target] }, kind);
    const body = (await readFile(target, "utf8")).trim();
    if (!body) throw new Error(`${kind} artifact is empty after editing: ${target}`);
    if (kind === "plan" && approvedPlanContextRef.current) {
      const currentPlan = latestPlanPathRef.current
        ? resolve(props.projectDir, latestPlanPathRef.current)
        : undefined;
      if (currentPlan === target) {
        approvedPlanContextRef.current = {
          ...approvedPlanContextRef.current,
          prosePlan: body,
        };
      }
    }
    const shown = target.startsWith(`${resolve(props.projectDir)}/`)
      ? target.slice(resolve(props.projectDir).length + 1)
      : target;
    return kind === "plan" && approvedPlanContextRef.current
      ? `Edited ${shown} and reloaded the pending plan.`
      : `Edited ${shown}.`;
  }

  async function editPendingPlan(): Promise<void> {
    setPlanApprovalPending(false);
    try {
      setCommandOutput(await editDurableArtifact("plan", ""));
    } catch (error) {
      setCommandOutput(`error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPlanApprovalPending(true);
    }
  }

  /** `e` on the draft picker. Mirrors editPendingPlan: open $EDITOR on the pending spec, report,
   * and leave specDraftPending set so the same picker re-appears once the editor closes. The
   * picker itself unmounts for the duration via the `!editorRequest` mount guard (Ink's useInput
   * would otherwise race $EDITOR for stdin) and remounts once editorRequest clears. */
  async function editPendingSpec(): Promise<void> {
    try {
      setCommandOutput(await editDurableArtifact("spec", ""));
    } catch (error) {
      setCommandOutput(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** enter/a: accept the requirements only. Implementation is the next, separate choice. */
  function approveSpecDraft(draft: { specPath: string }): void {
    setSpecDraftPending(null);
    setSpecHandoffPending(draft);
    setOrchestrationRetryPending(false);
    setCommandOutput(
      "Spec accepted. This approves the requirements only; choose how to implement them.",
    );
  }

  /** s / esc: keep the file on disk, start nothing. */
  function saveSpecDraft(draft: { specPath: string }): void {
    setSpecDraftPending(null);
    setCommandOutput(`Spec kept at ${draft.specPath}; no implementation was started.`);
  }

  /** r: swap the picker for the one-line revision prompt; handleSubmit sends the next line. */
  function beginSpecRevision(draft: { specPath: string }): void {
    setSpecDraftPending(null);
    setSpecRevisionPending(draft);
  }

  /** esc on the revision prompt: back to the draft picker, nothing sent. */
  function cancelSpecRevision(): void {
    const draft = specRevisionPending;
    setSpecRevisionPending(null);
    if (draft) setSpecDraftPending(draft);
  }

  async function executeSpecHandoff(
    draft: { specPath: string },
    choice: SpecExecutionChoice,
  ): Promise<void> {
    const { specPath } = draft;
    setCommandOutput(null); // clear the draft-picker's "Spec accepted" banner; it would otherwise
    // pin on screen through the model turn and any prompt that follows (each branch below sets its
    // own message where one applies).
    if (choice === "cancel") {
      setSpecHandoffPending(null);
      setOrchestrationRetryPending(false);
      structureFailureRef.current = null;
      setCommandOutput(`Spec kept at ${specPath}; no implementation was started.`);
      return;
    }
    const objective = `Implement the approved spec at \`${specPath}\`.`;
    let specBody = "";
    try {
      specBody = await readFile(resolve(props.projectDir, specPath), "utf8");
    } catch {
      setCommandOutput(`Couldn't read ${specPath}; the agent will read it directly.`);
    }
    const architectureRisk = specRequiresArchitectureReview(specBody);
    // `repair` is orchestrate with the previous structure failure kept for guided repair.
    const repairRequested = choice === "repair";
    const action = resolveSpecExecutionAction(
      repairRequested ? "orchestrate" : choice,
      architectureRisk,
    );
    if (action.kind === "orchestrate-plan") {
      // Orchestration decomposes the spec across independent workers, so an unresolved structural
      // seam is resolved by a mandatory planning pass before any worker starts.
      setSpecHandoffPending(null);
      setCommandOutput(`Architecture review required: ${architectureRisk}`);
      props.onSelectMode("plan");
      beginBusy();
      try {
        await runTurnAndMaybePromptApproval(buildSpecPlanPrompt(specPath, specBody), {
          request: objective,
          approvedSpec: { path: specPath, body: specBody },
        });
      } catch {
        // handleSubmit swallows turn errors the same way; the turn logs its own error event.
      } finally {
        setBusy(false);
      }
    } else if (action.kind === "orchestrate") {
      if (!repairRequested) structureFailureRef.current = null;
      await startOrchestration(objective, specBody, objective, "spec");
    } else if (action.kind === "plan") {
      setSpecHandoffPending(null);
      structureFailureRef.current = null;
      props.onSelectMode("plan");
      beginBusy();
      try {
        await runTurnAndMaybePromptApproval(buildSpecPlanPrompt(specPath, specBody), {
          request: objective,
          approvedSpec: { path: specPath, body: specBody },
        });
      } catch {
        // handleSubmit swallows turn errors the same way; the turn logs its own error event.
      } finally {
        setBusy(false);
      }
    } else {
      // `go` is an explicit direct-build choice. An architecture risk no longer silently reroutes
      // it into a planning pass; the risk is carried into the build as a guardrail and surfaced
      // as a notice, leaving the user's decision intact.
      setSpecHandoffPending(null);
      structureFailureRef.current = null;
      if (action.guardrail) {
        setCommandOutput(
          `Direct build requested; proceeding despite an architecture risk: ${action.guardrail} Choose plan instead for an implementation-planning pass first.`,
        );
      }
      beginBusy();
      try {
        await maybePromptLocationThenRun(buildDirectBuildObjective(objective, action.guardrail));
      } catch {
        // handleSubmit swallows turn errors the same way; the turn logs its own error event.
      } finally {
        setBusy(false);
      }
    }
  }

  async function handleSubmit(value: string) {
    if (!value.trim()) return;
    setCommandOutput(null); // clear any prior command panel on the next action
    setHistory((h) => (h[h.length - 1] === value ? h : [...h, value]));
    const slash = parseSlashCommand(value);
    // /edit is a terminal handoff, not agent work. Keeping busy false avoids a
    // spinner and prevents Cleetus's Escape handler from competing with the editor.
    if (slash?.name !== "edit") beginBusy();
    try {
      if (slash) {
        const cmd = props.commands.get(slash.name);
        if (!cmd) {
          setCommandOutput(`unknown command: /${slash.name}`);
          return;
        }
        const isWorkflow = slash.name === "workflow";
        if (isWorkflow) {
          props.log.append({
            sessionId,
            type: "workflow_command",
            payload: { text: value },
          });
        }
        const out: Array<{ text: string; presentation?: SlashPresentation }> = [];
        const commandAbort = new AbortController();
        abortRef.current = commandAbort;
        try {
          await cmd.run(slash.args, {
            cwd: props.cwd,
            print: (text, presentation) => out.push({ text, presentation }),
            signal: commandAbort.signal,
            openEditor: (request) => requestEditor(request, editorIntegration(slash.name)),
            editArtifact: editDurableArtifact,
            runPrompt: async (text) => {
              if (
                slash.name === "spec" ||
                (slash.name === "skill" && /^spec-creator(?:\s|$)/i.test(slash.args))
              ) {
                setSpecDraftPending(null);
                setSpecHandoffPending(null);
                setSpecRevisionPending(null);
                setOrchestrationRetryPending(false);
                structureFailureRef.current = null;
                specRevisionRef.current = null;
                specFlowActiveRef.current = true;
                // A fresh spec dialogue is an unrelated task; a paused or stale checklist from
                // whatever ran before it (e.g. an aborted build) has nothing to do with drafting
                // a spec and would otherwise sit on screen for the rest of the conversation.
                setTracker(EMPTY_TRACKER);
                setTodosExpanded(false);
              }
              await runPrompt(text);
            },
          });
          if (isWorkflow) {
            for (const item of out) {
              props.log.append({
                sessionId,
                type: "workflow_result",
                payload: {
                  text: item.text,
                  format: item.presentation?.format ?? "plain",
                  kind: item.presentation?.kind ?? "message",
                  workflow: item.presentation?.workflow,
                  status: item.presentation?.status,
                  runId: item.presentation?.runId,
                },
              });
            }
            setCommandOutput(null);
          } else {
            setCommandOutput(out.length ? out.map((item) => item.text).join("\n") : null);
          }
        } catch (e) {
          const message = `error: ${(e as Error).message}`;
          if (isWorkflow) {
            props.log.append({
              sessionId,
              type: "workflow_result",
              payload: {
                text: message,
                format: "plain",
                kind: "result",
                status: commandAbort.signal.aborted ? "cancelled" : "failed",
              },
            });
            setCommandOutput(null);
          } else {
            setCommandOutput(message);
          }
        } finally {
          if (commandAbort.signal.aborted) turnAbortedRef.current = true;
          if (abortRef.current === commandAbort) abortRef.current = null;
        }
        return;
      }
      if (specRevisionPending) {
        const draft = specRevisionPending;
        setSpecRevisionPending(null);
        specFlowActiveRef.current = true;
        specRevisionRef.current = draft;
        await runPrompt(buildSpecRevisionPrompt(draft.specPath, value), undefined, {
          userRequest: value,
        });
        return;
      }
      const workflowAbort = new AbortController();
      abortRef.current = workflowAbort;
      let handledWorkflow: boolean | undefined;
      try {
        handledWorkflow = await props.workflowController?.handleNatural(value, {
          sessionId,
          signal: workflowAbort.signal,
          recordInput: (text) => {
            props.log.append({
              sessionId,
              type: "workflow_command",
              payload: { text },
            });
          },
          print: (text, presentation) => {
            props.log.append({
              sessionId,
              type: "workflow_result",
              payload: {
                text,
                format: presentation?.format ?? "plain",
                kind: presentation?.kind ?? "message",
                workflow: presentation?.workflow,
                status: presentation?.status,
                runId: presentation?.runId,
              },
            });
          },
        });
      } finally {
        if (abortRef.current === workflowAbort) abortRef.current = null;
        if (workflowAbort.signal.aborted) turnAbortedRef.current = true;
      }
      if (handledWorkflow) {
        setCommandOutput(null);
        return;
      }
      if (specFlowActiveRef.current) {
        // Framing answers remain inside the active spec dialogue and must not be mistaken for an
        // ordinary build request by the generic plan-or-go gate.
        const normalized = value
          .trim()
          .toLowerCase()
          .replace(/[.!?]+$/, "");
        if (["cancel", "stop", "not now", "never mind", "nevermind"].includes(normalized)) {
          specFlowActiveRef.current = false;
          setCommandOutput("Spec drafting cancelled; no implementation was started.");
          return;
        }
        await runPrompt(value);
        return;
      }
      // In plan mode, typed approval or an explicit "implement the plan" request should do what
      // the inline approve prompt does. Recover the plan from durable history when the ephemeral
      // UI checkpoint was missed or the session was resumed.
      if (modeRef.current === "plan" && looksLikePlanExecutionRequest(value)) {
        if (!(await recoverApprovedPlanFromHistory())) {
          setPlanApprovalPending(false);
          setCommandOutput(
            "No complete implementation plan is available to approve. Continue planning or provide a revised numbered plan first.",
          );
          return;
        }
        await handleApprovePlan();
        return;
      }
      const decision = buildPromptOptions({
        mode: modeRef.current,
        orchestrationAvailable: orchestrationEnabledRef.current,
        planOrGoEnabled: props.planOrGoEnabled ?? false,
        text: value,
      });
      if (decision.show) {
        structureFailureRef.current = null;
        setBuildPromptPending({ text: value, showOrchestrate: decision.showOrchestrate });
        return; // wait for the choice; input stays disabled until a choice is made
      }
      await maybePromptLocationThenRun(value);
    } catch {
      // Turn errors are recorded as `error` events by the runtime and shown in
      // the permanent transcript; nothing to surface in the ephemeral lane here.
    } finally {
      setBusy(false);
    }
  }

  // One gate-flag object serves both the boundary effect and the Input JSX
  // (Step 8). Everything except `busy` from the old disabled expression.
  const gateFlags = {
    permissionPromptOpen: Boolean(prompt),
    workflowPermissionPromptOpen: Boolean(workflowPrompt),
    workflowInputPromptOpen: Boolean(workflowInput),
    editorHandoffOpen: Boolean(editorRequest),
    planApprovalPending,
    planOrchestratePending: Boolean(planOrchestratePending),
    taskListPending: Boolean(taskListPending),
    bootstrapLocationPending: Boolean(bootstrapLocationPending),
    buildPromptPending: Boolean(buildPromptPending),
    specDraftPending: Boolean(specDraftPending),
    specHandoffPending: Boolean(specHandoffPending),
    modelPickerOpen,
    modePickerOpen: modePicker.open,
    routePickerOpen,
    personaPickerOpen,
    effortPickerOpen,
    rewindPickerOpen,
    sessionPickerOpen,
    personalityPickerOpen,
    restoreOpen,
  } satisfies InputGateFlags;

  const liveReasoningActive = Boolean(
    (props.reasoningEnabled ?? true) && liveStream.reasoning.length > 0,
  );

  // Ctrl+R expands/collapses only the in-flight reasoning tail. It stays out of the input buffer,
  // and the per-call reset above means every new thinking window starts compact.
  useInput(
    (input, key) => {
      if (isToggleReasoningKey(input, key)) setReasoningExpanded((expanded) => !expanded);
    },
    { isActive: !inputDisabled(gateFlags) && liveReasoningActive },
  );

  // ^t unfolds the tracker into the full checklist, and nothing else — it is read-only. Gated on
  // the same condition as the input, so a permission prompt or picker keeps the keyboard.
  useInput(
    (input, key) => {
      if (key.ctrl && input === "t") setTodosExpanded((v) => !v);
    },
    { isActive: !inputDisabled(gateFlags) && tracker.todos.length > 0 },
  );

  // All complete: hold the green row ~2s, then commit a receipt to the transcript and clear the
  // list so the widget renders nothing. Re-running on a new list cancels a hold in flight.
  useEffect(() => {
    if (tracker.finishedAt === null) return;
    const count = tracker.todos.length;
    const elapsed =
      tracker.listStartedAt !== null ? tracker.finishedAt - tracker.listStartedAt : null;
    const id = setTimeout(() => {
      props.log.append({
        sessionId,
        type: "notice",
        payload: { text: completionReceipt(count, elapsed), kind: "todos_completed" },
      });
      setTracker(EMPTY_TRACKER);
      setTodosExpanded(false);
    }, COMPLETION_HOLD_MS);
    return () => clearTimeout(id);
  }, [tracker.finishedAt, tracker.listStartedAt, tracker.todos.length, props.log, sessionId]);

  // Idle boundary (Finding 9): deliver the queued message through the normal
  // router, exactly as if it were typed the moment the turn ended — unless a
  // choice prompt is up or the turn was aborted, in which case the text
  // drops into the input buffer, editable and unsent. It must never be
  // auto-sent where it would be misread as a reply.
  // A queued message must not be auto-sent where it would be misread as a spec revision.
  const boundaryPending = inputDisabled(gateFlags) || Boolean(specRevisionPending);
  useEffect(() => {
    if (busy) return;
    const action = resolveBoundary({
      queued: queuedRef.current,
      aborted: turnAbortedRef.current,
      hasPendingPrompt: boundaryPending,
    });
    if (action === "none") return;
    const q = queuedRef.current!;
    setQueuedBoth(null);
    if (action === "deliver") void handleSubmit(q);
    else prefillInput(q);
  });

  function handleModelSelect(provider: string, model: string) {
    const wasStartup = startupPickerRef.current;
    startupPickerRef.current = false;
    props.onSelectModel(provider, model);
    setModelPickerOpen(false);
    // Only after the *startup* model picker (not a later /model switch) do we
    // surface the restore offer, so it appears before the first user turn.
    if (wasStartup && props.restoreCandidate) setRestoreOpen(true);
  }

  function handleModeSelect(mode: PermissionMode) {
    props.onSelectMode(mode);
    setModePicker({ open: false });
  }

  function handleRouteSelect(mode: RouteMode) {
    props.onSelectRoute(mode);
    setRoutePickerOpen(false);
  }

  function handlePersonaSelect(id: PersonaId) {
    props.onSelectPersona(id);
    setPersonaPickerOpen(false);
  }

  function handleEffortSelect(level: EffortLevel) {
    props.onSelectEffort(level);
    setEffortPickerOpen(false);
  }

  function handleRewindSelect(turnNumber: number) {
    void props.onSelectRewind(turnNumber);
    setRewindPickerOpen(false);
  }

  function handleSessionSelect(id: string) {
    // Load the snapshot into the runtime + re-point bin-side state (onSelectSession),
    // then re-key the view to the resumed session so events + turns target it.
    props.onSelectSession?.(id);
    setSpecDraftPending(null);
    setSpecHandoffPending(null);
    setOrchestrationRetryPending(false);
    structureFailureRef.current = null;
    specFlowActiveRef.current = false;
    specRevisionRef.current = null;
    setSpecRevisionPending(null);
    setTodosExpanded(false); // the list itself is cleared by the re-seeding subscription effect
    setSessionId(id);
    setSessionPickerOpen(false);
  }

  function handlePersonalitySelect(id: PersonalityId) {
    props.onSelectPersonality(id);
    setPersonalityPickerOpen(false);
  }

  async function handlePermission(action: PermissionAction) {
    const p = promptRef.current;
    if (!p) return;
    if (typeof action === "object" && action.kind === "grant") {
      const path =
        action.scope === "project" ? props.projectPermissionsPath : props.globalPermissionsPath;
      await persistRule(path, { ...action.rule, decision: action.decision });
      addRule(props.permissions, action.scope, action.rule, action.decision);
      promptRef.current = null;
      setPrompt(null);
      p.respond(action.decision, false);
      return;
    }
    const decision: Decision = action === "deny" ? "deny" : "allow";
    if (!p.escapes) {
      if (action === "allow_project") {
        await persistRule(props.projectPermissionsPath, { tool: p.tool, decision: "allow" });
        // Update the live rules too — they are loaded once at startup, so without
        // this the grant only takes effect on the next launch and the prompt repeats.
        addAllowRule(props.permissions, "project", p.tool);
      } else if (action === "allow_global") {
        await persistRule(props.globalPermissionsPath, { tool: p.tool, decision: "allow" });
        addAllowRule(props.permissions, "global", p.tool);
      }
    }
    promptRef.current = null;
    setPrompt(null);
    const grantOutside = Boolean(p.escapes) && action === "allow_global";
    p.respond(decision, grantOutside);
  }

  // Mirror History's own prose-render condition (streamingEnabled-gated): only collapse the
  // reasoning tail for prose that will actually render, else the user briefly sees neither.
  const proseActive =
    busy && (props.streamingEnabled ?? true) && !!liveStream && liveStream.prose.length > 0;
  // The tracker's rows come out of the live windows' budget, so an expanded checklist shrinks the
  // reasoning/prose tails rather than pushing the input off the bottom of the terminal.
  const todoBudget = trackerBudget(rows, {
    active: tracker.todos.length > 0,
    expanded: todosExpanded,
    todoCount: tracker.todos.length,
  });
  // Reserve the REAL height of the chrome that shares the viewport with the live reasoning/prose
  // tail — measured, not a fixed guess. If the dynamic region reaches the terminal height Ink takes
  // its full-screen-clear branch, which on a terminal that ignores ESC[3J (macOS Terminal) reprints
  // the committed answer into scrollback (the duplicate-final-answer bug). A wrapped status roster
  // or a queued/staged indicator is exactly what the old fixed reserve missed.
  const columns = stdout?.columns ?? 80;
  const roster = formatModelRoster({
    active: activeDisplay,
    orchestration: {
      ...props.orchestration,
      enabled: orchestrationEnabled,
      configured:
        props.orchestration.enabled ||
        Boolean(props.orchestration.orchestratorModel || props.orchestration.workerModel),
    },
  });
  const promptShowing = Boolean(prompt || workflowPrompt || workflowInput || editorRequest);
  const reserve = liveWindowReserve({
    // The "thinking…" header renders whenever reasoning is buffered, prose streaming or not.
    reasoningHeader:
      (props.reasoningEnabled ?? true) && !!liveStream && liveStream.reasoning.length > 0,
    busyIndicator: busy && !promptShowing,
    queued: queued != null,
    staged: stagedImages.length > 0,
    structuring: structuringOrchestration,
    commandPanelLines: commandOutput ? commandOutput.split("\n").length + 2 : 0, // +2 round border
    // The roster line wraps on a narrow terminal; the status line below it is one or two rows.
    statusBarLines: wrappedRows(` ${roster}`, columns) + 2,
    inputLines: editorRequest ? 0 : 2, // prompt row + its marginTop; wider input covered by margin
    trackerRows: todoBudget.totalRows,
  });
  const liveBudget = liveWindowBudget(rows, {
    proseActive,
    reasoningCap: reasoningExpanded ? (props.reasoningLines ?? 10) : 0,
    proseCap: props.proseLines ?? 12,
    reserve,
  });

  return (
    <Box flexDirection="column">
      <History
        model={historyModel}
        sessionKey={sessionId}
        liveStream={liveStream}
        streamingEnabled={props.streamingEnabled ?? true}
        reasoningEnabled={props.reasoningEnabled ?? true}
        reasoningLines={liveBudget.reasoningLines}
        reasoningExpanded={reasoningExpanded}
        proseLines={liveBudget.proseLines}
      />
      {busy && !editorRequest && !prompt && !workflowPrompt && !workflowInput && (
        <BusyIndicator events={events} />
      )}
      {prompt && (
        <PermissionPrompt
          tool={prompt.tool}
          summary={prompt.argsSummary}
          targetPath={prompt.targetPath}
          readEscape={prompt.readEscape}
          escapes={prompt.escapes}
          onResolve={handlePermission}
        />
      )}
      {editorPermissionPrompt && (
        <EditorPermissionPrompt
          editor={editorPermissionPrompt.editor}
          targets={editorPermissionPrompt.targets}
          onResolve={(allowed) => {
            const pending = editorPermissionPrompt;
            setEditorPermissionPrompt(null);
            pending.resolve(allowed);
          }}
        />
      )}
      {modelPickerOpen && (
        <ModelPickerModal
          providers={props.providers}
          active={props.getActive()}
          onSelect={handleModelSelect}
          onCancel={() => {
            if (startupPickerRef.current) {
              startupPickerRef.current = false;
              props.onStartupCancel?.();
              return;
            }
            setModelPickerOpen(false);
          }}
        />
      )}
      {modePicker.open && (
        <ModePickerModal
          active={mode}
          initial={modePicker.initial}
          onSelect={handleModeSelect}
          onCancel={() => setModePicker({ open: false })}
        />
      )}
      {routePickerOpen && (
        <RoutePickerModal
          active={routeMode}
          tiersConfigured={props.tiersConfigured}
          onSelect={handleRouteSelect}
          onCancel={() => setRoutePickerOpen(false)}
        />
      )}
      {personaPickerOpen && (
        <PersonaPickerModal
          active={persona}
          onSelect={handlePersonaSelect}
          onCancel={() => setPersonaPickerOpen(false)}
        />
      )}
      {effortPickerOpen && (
        <EffortPickerModal
          active={effort}
          onSelect={handleEffortSelect}
          onCancel={() => setEffortPickerOpen(false)}
        />
      )}
      {rewindPickerOpen && (
        <RewindPickerModal
          checkpoints={props.getCheckpoints()}
          onSelect={handleRewindSelect}
          onCancel={() => setRewindPickerOpen(false)}
        />
      )}
      {sessionPickerOpen && (
        <SessionPickerModal
          rows={props.getResumableSessions?.() ?? []}
          onSelect={handleSessionSelect}
          onCancel={() => setSessionPickerOpen(false)}
        />
      )}
      {personalityPickerOpen && (
        <PersonalityPickerModal
          active={personality}
          onSelect={handlePersonalitySelect}
          onCancel={() => setPersonalityPickerOpen(false)}
        />
      )}
      {restoreOpen && props.restoreCandidate && (
        <RestorePrompt
          snapshot={props.restoreCandidate}
          onRestore={() => {
            props.onRestoreTodos?.(props.restoreCandidate!);
            setRestoreOpen(false);
          }}
          onDismiss={() => {
            props.onDismissTodos?.(props.restoreCandidate!);
            setRestoreOpen(false);
          }}
        />
      )}
      {workflowPrompt && (
        <WorkflowPermissionPrompt
          request={workflowPrompt.request}
          onResolve={(decision) => {
            workflowPrompt.resolve(decision);
            setWorkflowPrompt(null);
          }}
        />
      )}
      {workflowInput && (
        <WorkflowInputPrompt
          workflow={workflowInput.workflow}
          schema={workflowInput.schema}
          onResolve={(inputs) => {
            workflowInput.resolve(inputs);
            setWorkflowInput(null);
          }}
          onCancel={(error) => {
            workflowInput.reject(error);
            setWorkflowInput(null);
          }}
        />
      )}
      <CommandPanel text={commandOutput} />
      {structuringOrchestration && <OrchestrationStructuringStatus />}
      {specDraftPending && !busy && !editorRequest && (
        <SpecDraftPrompt
          specPath={specDraftPending.specPath}
          onApprove={() => approveSpecDraft(specDraftPending)}
          onRevise={() => beginSpecRevision(specDraftPending)}
          onSave={() => saveSpecDraft(specDraftPending)}
          onEdit={() => void editPendingSpec()}
        />
      )}
      {specRevisionPending && !busy && !editorRequest && (
        <SpecRevisionPrompt specPath={specRevisionPending.specPath} onBack={cancelSpecRevision} />
      )}
      {specHandoffPending && !busy && !bootstrapLocationPending && !taskListPending && (
        <SpecExecutionPrompt
          orchestrationAvailable={orchestrationEnabled}
          orchestrationRetry={orchestrationRetryPending}
          onPlan={() => void executeSpecHandoff(specHandoffPending, "plan")}
          onOrchestrate={() => void executeSpecHandoff(specHandoffPending, "orchestrate")}
          onRepair={() => void executeSpecHandoff(specHandoffPending, "repair")}
          onGo={() => void executeSpecHandoff(specHandoffPending, "go")}
          onCancel={() => void executeSpecHandoff(specHandoffPending, "cancel")}
        />
      )}
      {buildPromptPending && !busy && !bootstrapLocationPending && !taskListPending && (
        <BuildPrompt
          showOrchestrate={buildPromptPending.showOrchestrate}
          orchestrationRetry={orchestrationRetryPending}
          onOrchestrate={() => void runBuildPromptChoice("orchestrate")}
          onRepair={() => void runBuildPromptChoice("orchestrate", true)}
          onPlan={() => void runBuildPromptChoice("plan")}
          onGo={() => void runBuildPromptChoice("go")}
          onCancel={cancelBuildPrompt}
        />
      )}
      {planApprovalPending && !busy && (
        <PlanApprovalPrompt
          onApprove={handleApprovePlan}
          onEdit={() => void editPendingPlan()}
          onDismiss={() => setPlanApprovalPending(false)}
        />
      )}
      {planOrchestratePending && !busy && !bootstrapLocationPending && !taskListPending && (
        <PlanOrchestratePrompt
          orchestrationRetry={orchestrationRetryPending}
          onOrchestrate={() => void runPlanOrchestrateChoice("orchestrate")}
          onRepair={() => void runPlanOrchestrateChoice("orchestrate", true)}
          onGo={() => void runPlanOrchestrateChoice("go")}
          onCancel={cancelPlanOrchestrate}
        />
      )}
      {taskListPending && !busy && (
        <TaskListApprovalPrompt
          tasks={pendingPlanRef.current?.tasks ?? []}
          admission={taskListPending.admission}
          canRevise={taskListPending.revisionAttempts < 1}
          onApprove={() => void approveTaskList()}
          onGo={() => void runSingleFromTaskList()}
          onRevise={() => void reviseTaskList()}
          onDismiss={dismissTaskList}
        />
      )}
      {bootstrapLocationPending && !busy && (
        <BootstrapLocationPrompt
          suggestedName={bootstrapLocationPending.suggestedName}
          onCwd={() => void resolveBootstrapLocation({ kind: "cwd" })}
          onSubdir={() =>
            void resolveBootstrapLocation({
              kind: "subdir",
              name: bootstrapLocationPending.suggestedName,
            })
          }
          onDismiss={() => {
            bootstrapStashRef.current = null;
            setBootstrapLocationPending(null);
          }}
        />
      )}
      {/* Outside <Static>, so it repaints every frame. Inside it, the tracker would render once
          and then silently never update again — the single most important constraint here. */}
      <TodoTracker
        todos={tracker.todos}
        expanded={todosExpanded}
        startedAt={tracker.startedAt}
        listStartedAt={tracker.listStartedAt}
        finishedAt={tracker.finishedAt}
        busy={busy}
        maxRows={todoBudget.bodyRows}
      />
      {queued != null && (
        <Box marginTop={1}>
          <Text color={t.dim}>⧗ queued: {queuedLine(queued)}</Text>
        </Box>
      )}
      {stagedIndicator(stagedImages.length) != null && (
        <Box marginTop={1}>
          <Text color={t.dim}>{stagedIndicator(stagedImages.length)}</Text>
        </Box>
      )}
      {!editorRequest && (
        <Box marginTop={queued != null ? 0 : 1}>
          <Input
            prompt="cleetus>"
            onSubmit={submitOrQueue}
            disabled={inputDisabled(gateFlags)}
            seed={inputSeed}
            onClearEmpty={() => setQueuedBoth(null)}
            complete={(line) => {
              const slash = completeSlashLine(props.commands, line);
              if (slash.length) return slash;
              const editor = completeEditorLine(
                {
                  workflows: props.workflowController
                    ? () => props.workflowController!.completionWorkflows()
                    : undefined,
                  skills: props.skills,
                  artifacts: (kind) =>
                    listArtifactEditTargets({
                      kind,
                      projectDir: props.projectDir,
                      specsDir: props.specsDir,
                    }),
                },
                line,
              );
              const skills = completeSkillLine(props.skills, line);
              if (editor.length || skills.length) return [...editor, ...skills];
              const routes = completeRouteLine(line);
              if (routes.length) return routes;
              const personas = completePersonaLine(line);
              if (personas.length) return personas;
              const efforts = completeEffortLine(line);
              if (efforts.length) return efforts;
              const voices = completePersonalityLine(line);
              if (voices.length) return voices;
              const modes = completeModeLine(line);
              return modes.length ? modes : completeModelLine(props.catalog, line);
            }}
            history={history}
          />
        </Box>
      )}
      <StatusBar
        roster={roster}
        project={project}
        sessionId={sessionId}
        tokens={tokens}
        fuckit={mode === "fuckit"}
        planMode={mode === "plan"}
        route={{ mode: routeMode, tier: lastTier }}
        persona={persona}
        personality={personality}
        launchScope={props.launchScope}
      />
    </Box>
  );
}
