import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { maybeGcOnStartup } from "../agent/attachment-gc";
import { resolveStartEffort } from "../agent/effort";
import { renderEnvironment } from "../agent/environment";
import {
  gatedVoiceCorrection,
  overlayFor,
  resolveStartPersonality,
  voiceTurnReminder,
} from "../agent/personalities";
import { personaInfo, personaPrompt, resolveStartPersona } from "../agent/personas";
import { projectAuditDbPath } from "../agent/recovery-path";
import { lastUserRequest, runReview } from "../agent/review";
import { AgentRuntime, type AgentRuntimeOptions } from "../agent/runtime";
import { ensureParentDir, resolveSessionDbPath } from "../agent/session-db-path";
import { SessionHistoryStore } from "../agent/session-history";
import { buildSpecTurn, specDatePrefix } from "../agent/spec";
import { buildSubagentSpawner } from "../agent/subagent";
import { buildSystemPrompt } from "../agent/system-prompt";
import { loadSystemPromptOverride } from "../agent/system-prompt-override";
import { inheritedProjectMemoryPath, projectMemoryPath } from "../agent/tui-project-scope";
import type { ResolvePermission } from "../agent/types";
import type { CheckpointSummary } from "../checkpoint/types";
import { readAppState, writeAppState } from "../config/app-state";
import { resolveConfigRoot } from "../config/config-root";
import { applyLaunchOverrides } from "../config/launch-overrides";
import { type LaunchScope, establishLaunchScope } from "../config/launch-scope";
import { loadConfig } from "../config/loader";
import { resolveMaxToolLoops } from "../config/loop-cap";
import type { ResizeConfig } from "../config/resize";
import {
  createScratchDir,
  reapStaleScratchDirs,
  registerScratchCleanup,
} from "../config/scratch-lifecycle";
import type { VisionConfig } from "../config/vision";
import { EventLog } from "../events/log";
import { runGit } from "../git/run";
import { type LearnPlaybookController, LearnPlaybookService } from "../learn/service";
import { openDatabase } from "../lib/db";
import type { McpServerStatus } from "../mcp/types";
import { loadMemories } from "../memory/load";
import { MemoryStore } from "../memory/store";
import { makeRulesForCwd } from "../permission/loader";
import type { Decision, PermissionRules } from "../permission/types";
import { catalogEntries, fetchCatalog } from "../providers/catalog";
import { buildProvider } from "../providers/factory";
import { ModelContextCache } from "../providers/model-context-cache";
import { ProviderRegistry } from "../providers/registry";
import { resolveStartupChoice } from "../providers/startup";
import { truncateMapToBudget } from "../repomap/render";
import { createSandboxWithInfo } from "../sandbox/factory";
import type { Sandbox } from "../sandbox/types";
import { privateDirectory, privateFile } from "../security/private-state";
import { bootstrapSkills } from "../skills/bootstrap";
import { composeSkillBody, renderSkillReminder, stripSystemReminders } from "../skills/compose";
import type { SkillRegistry } from "../skills/registry";
import { triggeredSkills } from "../skills/trigger";
import { ToolDispatcher } from "../tools/dispatcher";
import { ToolRegistry } from "../tools/registry";
import { RunWorkflowTool } from "../tools/run-workflow";
import { activateWorkflowDraft } from "../workflows/creator/activate";
import { WorkflowCreatorController } from "../workflows/creator/controller";
import { WorkflowDraftStore } from "../workflows/creator/draft-store";
import { StructuredWorkflowCreatorModel } from "../workflows/creator/model";
import { WorkflowCommandController } from "../workflows/interactive-controller";
import { WorkflowModelCallService } from "../workflows/model-call";
import { loadWorkflowPackage } from "../workflows/package";
import { connectConfiguredAcpMcp } from "./configured-mcp";
import { DirectFileBridge, type FileBridge } from "./file-bridge";
import { runAcpInsights } from "./insights";
import {
  type AcpProjectServiceHolder,
  AcpProjectServiceRegistry,
  projectServiceAdapters,
} from "./project-services";
import { buildAcpPromptScope } from "./prompt-scope";
import { buildAcpRouter } from "./router";
import {
  type AcpSessionConfigController,
  type ActiveAcpSessionHolder,
  createAcpSessionConfig,
} from "./session-config";
import { registerAcpTools } from "./toolset";
import type { WorkflowAuthorizationRouter } from "./workflow-permission";

export interface AcpRuntimeOptions {
  provider?: string;
  model?: string;
  /** `--route` flag; falls back to config `routing.default_mode`. */
  route?: string;
  /** `--route-small/large-provider/model` flags: routing tier overrides (overlay config.routing.tiers). */
  routeSmallProvider?: string;
  routeSmallModel?: string;
  routeLargeProvider?: string;
  routeLargeModel?: string;
  sessionDb?: string;
  /** `--persona` flag; falls back to config `default_persona`. */
  persona?: string;
  /** `--personality` flag (voice overlay); falls back to config `default_personality`. */
  personality?: string;
  /** `--effort` flag; falls back to config `default_effort`. */
  effort?: string;
  /** `--instructions` flag: path to an app-supplied system-prompt instructions file. */
  instructions?: string;
  /** `--config-dir` flag: config root override. */
  configDir?: string;
  /** `--project-dir` flag: project-home scope anchor (memory/instructions/artifacts), distinct
   *  from cwd. Undefined = loose conversation (no project scope). */
  projectHome?: string;
  /** `--global` flag: operate against the persistent global workspace (default ~/.cleetus). */
  global?: boolean;
  /** `--scratch` flag: operate against a fresh ephemeral directory, deleted on exit. */
  scratch?: boolean;
  /** `--no-project-instructions` → false. Default true. */
  inheritProjectInstructions?: boolean;
  /** `--no-project-memory` → false. Default true. */
  inheritProjectMemory?: boolean;
  /** `--verbose` forwards warning and internal diagnostic notices to the ACP client. */
  verbose?: boolean;
}

/**
 * CONNECTION-GLOBAL HOLDERS — GUARDED BY THE ACP TURN FIFO
 *
 * `permissionRouter`, `fileBridgeHolder`, `sandboxHolder`, and the active project-service holder
 * are shared across one ACP connection. `registerSessionMethods` serializes prompt and compact
 * operations before installing them, then resets them in `finally`. The transport remains
 * concurrent, so cancellation and unrelated control requests are not blocked by a model turn.
 */

/** Mutable holder that lets `session/prompt` swap the active resolver each turn without
 *  rebuilding the runtime. The runtime delegates every permission check through this indirection.
 *  The default deny keeps the runtime safe while no turn is in flight. */
export interface PermissionRouter {
  current: ResolvePermission;
}

/** Mutable holder that lets `session/prompt` swap the active FileBridge per turn without
 *  rebuilding the runtime. The delegating bridge reads `fileBridgeHolder.current` at call-time
 *  so the live value (not the startup snapshot) is always used. */
export interface FileBridgeHolder {
  current: FileBridge;
}

/** Mutable holder that lets `session/prompt` swap the active Sandbox per turn without rebuilding
 *  the runtime. The delegating sandbox forwards to `sandboxHolder.current` at call-time so the
 *  live value (not the startup snapshot) is always used. Default is the real sandbox. */
export interface SandboxHolder {
  current: Sandbox;
}

/** Mutable holder mirroring cleetus's plan-mode flag. `session/set_mode` flips this and the
 *  runtime reads it via `planMode: () => planModeHolder.current` so `modeId === "plan"` actually
 *  blocks mutating tools. Default off. */
export interface PlanModeHolder {
  current: boolean;
}

export interface AcpRuntimeBundle {
  runtime: AgentRuntime;
  log: EventLog;
  projectDir: string;
  /** The launch scope resolved from `--global`/`--scratch` (or the default project scope). */
  launchScope: LaunchScope;
  /** Resolved vision settings (project > global > default) used to gate/store ACP image blocks. */
  vision: VisionConfig;
  /** Resolved resize-on-ingest settings forwarded to `storeImage`/`resolveAttachmentPaths`. */
  resize: ResizeConfig;
  provider: string;
  model: string;
  permissionRouter: PermissionRouter;
  fileBridgeHolder: FileBridgeHolder;
  sandboxHolder: SandboxHolder;
  /** The underlying real sandbox — never swapped out. Used to reset sandboxHolder after a turn. */
  realSandbox: Sandbox;
  /** Persists/restores per-session conversation snapshots; `session/load` replays from this. */
  historyStore: SessionHistoryStore;
  /** The shared tool registry — MCP passthrough registers client servers' tools into it. */
  tools: ToolRegistry;
  /** Cleetus-configured MCP names and connection state, shared by every ACP session. */
  configuredMcp: {
    names: Set<string>;
    statuses: McpServerStatus[];
  };
  /** Live registry used by ACP command advertisement and manual `/skill` execution. */
  skills: SkillRegistry;
  /** Session-isolated learned-playbook controller used by the advertised `/learn` command. */
  learnPlaybookForSession: (sessionId: string) => LearnPlaybookController;
  /** Build the seeded agent turn used by the advertised `/spec` command. */
  buildSpecSeed: (idea: string) => string | undefined;
  /** Effective emphasized instruction text exposed by `/instructions`. */
  instructions: string;
  /** Durable global/project stores exposed by `/memory`. */
  memory: { global: MemoryStore; project: MemoryStore };
  /** Mutable plan-mode flag toggled by `session/set_mode`. */
  planModeHolder: PlanModeHolder;
  /** Per-session ACP-native provider/model/persona/personality/effort/routing selectors. */
  sessionConfig: AcpSessionConfigController;
  /** Identifies the session whose settings runtime closures should read during the active turn. */
  activeSessionHolder: ActiveAcpSessionHolder;
  /** Selects the canonical-cwd repo map and runtime-quality services for one serialized turn. */
  projectContext: {
    activate(cwd: string): Promise<void>;
    reset(): void;
  };
  /** Command services that require the active canonical project selected by projectContext. */
  projectCommands: {
    getCheckpoints(sessionId: string): CheckpointSummary[];
    rewindToCheckpoint(sessionId: string, turnNumber: number): Promise<boolean>;
    runInsights(sessionId: string, args: string, signal?: AbortSignal): Promise<string>;
    runReview(sessionId: string, args: string, signal?: AbortSignal): Promise<string | undefined>;
    runIndex(sessionId: string, args: string, signal?: AbortSignal): Promise<string>;
  };
  workflowController: WorkflowCommandController;
  workflowAuthorizationRouter: WorkflowAuthorizationRouter;
  /** Per-session project/global permission rule loader (project layer from the session's cwd,
   *  cached per cwd). */
  rulesForCwd: (cwd: string) => Promise<PermissionRules>;
  /** Silently-degraded sandbox consent state; undefined when the sandbox is not degraded. */
  degradedConsent?: { acked: boolean; persistAck: () => void };
  dispose: () => Promise<void>;
}

/** Build a focused, working AgentRuntime for the ACP server.
 *
 *  Mirrors the terminal's config/provider, sandbox, standard tool, configured-MCP, routing,
 *  persona/skill/memory, history, model-context detection, and permission seams while adapting
 *  file/terminal operations to ACP client capabilities. Repo maps, diagnostics, formatting, hooks,
 *  and checkpoints are selected by canonical session cwd. Build gates and orchestration remain
 *  deliberately deferred and are tracked in the project todo list. */
export async function buildAcpRuntime(opts: AcpRuntimeOptions): Promise<AcpRuntimeBundle> {
  const globalDir = resolveConfigRoot(opts.configDir, homedir(), process.cwd());
  const GLOBAL_CONFIG = join(globalDir, "config.yaml");
  const launchCwd = realpathSync(process.cwd());
  const preConfig = await loadConfig({ globalPath: GLOBAL_CONFIG, projectDir: launchCwd });
  // global_workspace_dir must be cwd-independent (spec §D): read it from the global config alone,
  // not the cwd-merged preConfig where a project .cleetus/config.yaml could shadow it.
  const globalWorkspaceDir = opts.global
    ? (await loadConfig({ globalPath: GLOBAL_CONFIG, projectDir: globalDir })).globalWorkspaceDir
    : undefined;
  const launchScope: LaunchScope = establishLaunchScope(
    {
      global: opts.global ?? false,
      scratch: opts.scratch ?? false,
      cwd: launchCwd,
      projectHome: opts.projectHome,
      home: homedir(),
      globalWorkspaceDir,
      makeScratchDir: createScratchDir,
    },
    {
      chdir: (d) => process.chdir(d),
      mkdirp: (d) => mkdirSync(d, { recursive: true }),
      registerCleanup: (d) => void registerScratchCleanup(d),
      reapStale: () => void reapStaleScratchDirs({ now: Date.now() }),
    },
  );
  const projectDir = realpathSync(process.cwd());
  const loaded =
    launchScope.kind === "project"
      ? preConfig
      : await loadConfig({ globalPath: GLOBAL_CONFIG, projectDir });
  // Overlay per-launch routing tiers from flags (flag > config). Orchestration is NOT overlaid on
  // the ACP path — the ACP runtime has no orchestration engine (chat-orchestration is deferred).
  const { config, warnings: overrideWarnings } = applyLaunchOverrides(loaded, {
    routeSmallProvider: opts.routeSmallProvider,
    routeSmallModel: opts.routeSmallModel,
    routeLargeProvider: opts.routeLargeProvider,
    routeLargeModel: opts.routeLargeModel,
  });
  for (const w of overrideWarnings) console.error(`[cleetus acp] WARNING: ${w}`);

  if (Object.keys(config.providers).length === 0) {
    throw new Error(
      `no providers configured. add an lmstudio, ollama, or llama.cpp provider to ${GLOBAL_CONFIG}`,
    );
  }

  const providers = new ProviderRegistry();
  for (const [name, p] of Object.entries(config.providers)) {
    providers.register(name, buildProvider(p.type, p.baseUrl, p.apiKey));
  }
  const modelContext = new ModelContextCache(providers);

  const catalog = await fetchCatalog(providers);
  const startup = resolveStartupChoice(catalog, {
    requestedProvider: opts.provider,
    requestedModel: opts.model,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
  });
  let providerName: string;
  let model: string;
  if (startup.kind === "ready") {
    providerName = startup.provider;
    model = startup.model;
  } else if (startup.kind === "error") {
    throw new Error(startup.message);
  } else {
    // "pick" — no usable default. The ACP server has no interactive picker, so fall back to
    // the first available (provider, model), mirroring the one-shot CLI path.
    const first = catalogEntries(catalog)[0];
    if (!first) throw new Error("no models available from any configured provider");
    providerName = first.provider;
    model = first.model;
  }

  privateDirectory(join(projectDir, ".cleetus"));
  privateDirectory(join(opts.projectHome ?? projectDir, ".cleetus"));
  privateDirectory(globalDir);
  privateFile(GLOBAL_CONFIG);
  privateFile(join(projectDir, ".cleetus", "config.yaml"));
  const sessionsDbPath = resolveSessionDbPath(projectDir, opts.sessionDb);
  ensureParentDir(sessionsDbPath);
  const log = new EventLog(sessionsDbPath, {
    mirrorPath: projectAuditDbPath(globalDir, projectDir),
  });
  // Second handle on the same sqlite file (EventLog owns its own). Mirrors cleetus.ts: the
  // EventLog and SessionHistoryStore each hold their own connection to sessions.db.
  const db = openDatabase(sessionsDbPath);
  const historyStore = new SessionHistoryStore(db);
  maybeGcOnStartup(config.attachments, join(projectDir, ".cleetus", "attachments"), db, (line) =>
    process.stderr.write(`${line}\n`),
  );

  const { sandbox: realSandbox, degraded: sandboxDegraded } = await createSandboxWithInfo(
    config.sandbox,
    projectDir,
  );

  const appState = sandboxDegraded ? await readAppState(globalDir) : {};
  const degradedConsent = sandboxDegraded
    ? {
        acked: appState.sandboxDegradedAck === true,
        // Best-effort: consent persistence failing (EACCES/EROFS/ENOSPC — plausible in exactly
        // the degraded environments this targets) must not crash the process; the in-memory
        // ack still holds for this process.
        persistAck: () =>
          void writeAppState(globalDir, { sandboxDegradedAck: true }).catch(() => {}),
      }
    : undefined;

  // Project rules load per-session from the session's OWN cwd — the same file "Always reject"
  // persists to — instead of once from the launch dir (persist/load cwd asymmetry Minor).
  const rulesForCwd = makeRulesForCwd(join(globalDir, "permissions.yaml"));

  // Mutable holder — session-methods swaps `current` on each turn so the runtime always delegates
  // to the per-turn resolver without being rebuilt. Safe default: deny while no turn is active.
  const permissionRouter: PermissionRouter = { current: async (): Promise<Decision> => "deny" };

  // Mutable holder for file I/O routing. session-methods swaps `current` to an AcpFileBridge
  // when the client advertises fs capabilities. A delegating bridge forwards to the live value
  // so the tools (built once, before initialize) always use the per-turn bridge.
  const fileBridgeHolder: FileBridgeHolder = { current: new DirectFileBridge() };
  const delegatingBridge: FileBridge = {
    readTextFile: (absPath) => fileBridgeHolder.current.readTextFile(absPath),
    writeTextFile: (absPath, content) => fileBridgeHolder.current.writeTextFile(absPath, content),
  };

  // Mutable holder for sandbox routing. session-methods swaps `current` to an AcpSandbox when
  // the client advertises `terminal` capability. The delegating sandbox forwards to the live value
  // so BashTool (built once, before initialize) always uses the per-turn sandbox.
  const sandboxHolder: SandboxHolder = { current: realSandbox };
  const delegatingSandbox: Sandbox = {
    exec: (command, opts) => sandboxHolder.current.exec(command, opts),
    dispose: () => realSandbox.dispose(),
    writeRoot: () => sandboxHolder.current.writeRoot(),
  };
  const projectServiceHolder: AcpProjectServiceHolder = {};
  const projectServices = new AcpProjectServiceRegistry({
    loadConfig: (cwd) => loadConfig({ globalPath: GLOBAL_CONFIG, projectDir: cwd }),
    sandbox: delegatingSandbox,
    log,
    db,
    globalDir,
    providers,
    onWarning: (warning) => console.error(`[cleetus acp] WARNING: ${warning}`),
  });
  const projectAdapters = projectServiceAdapters(projectServiceHolder);

  const globalMemoryPath = join(globalDir, "memory.md");
  const projectMemory = projectMemoryPath(projectDir, opts.projectHome);
  const memory = {
    global: new MemoryStore(globalMemoryPath),
    project: new MemoryStore(projectMemory),
  };
  const tools = new ToolRegistry();
  const toolset = await registerAcpTools({
    tools,
    fileBridge: delegatingBridge,
    sandbox: delegatingSandbox,
    config,
    projectDir,
    projectScopeDir: opts.projectHome ?? projectDir,
    globalDir,
    providers,
    memory,
    rememberDefaultScope: launchScope.defaultMemoryScope,
    codeSearchForProject: (cwd) =>
      projectServiceHolder.current?.cwd === cwd ? projectServiceHolder.current.vectors : undefined,
  });
  for (const warning of toolset.warnings) {
    console.error(`[cleetus acp] WARNING: ${warning}`);
  }
  const { buildWorkflowService } = await import("../ui/cli/workflow");
  const workflowAuthorizationRouter: WorkflowAuthorizationRouter = {
    current: async () => "deny",
  };
  const workflowRuntime = await buildWorkflowService({
    projectDir,
    configDir: globalDir,
    execution: true,
    runtime: {
      sandbox: delegatingSandbox,
      providers,
      defaultProvider: providerName,
      defaultModel: model,
    },
    requestAuthorization: (request) => workflowAuthorizationRouter.current(request),
  });
  tools.register(new RunWorkflowTool(workflowRuntime.service));
  const configuredMcp = await connectConfiguredAcpMcp({
    servers: config.mcpServers,
    tools,
    log,
  });
  const dispatcher = new ToolDispatcher(tools);

  // Persona, personality (voice overlay), and effort mirror the full runtime's startup resolution
  // (src/bin/cleetus.ts): the `--persona/--personality/--effort` flags the desktop passes win over
  // the config defaults, and an unknown flag falls back to the default with a warning. Without this
  // the ACP chat path silently dropped all three (personaPrompt/overlay were hardcoded empty).
  const { persona: personaId, warnings: personaWarnings } = resolveStartPersona(
    config.defaultPersona,
    opts.persona,
  );
  const { personality: personalityId, warnings: personalityWarnings } = resolveStartPersonality(
    config.defaultPersonality,
    opts.personality,
  );
  const { effort: effortLevel, warnings: effortWarnings } = resolveStartEffort(
    config.defaultEffort,
    opts.effort,
  );
  for (const w of [...personaWarnings, ...personalityWarnings, ...effortWarnings]) {
    console.error(`[cleetus acp] WARNING: ${w}`);
  }
  const activeSessionHolder: ActiveAcpSessionHolder = { current: null };
  const sessionConfigRef: { current?: AcpSessionConfigController } = {};
  const currentSessionConfig = () => sessionConfigRef.current!.current();

  const scope = await buildAcpPromptScope({
    globalDir,
    projectDir,
    instructionsFlag: opts.instructions,
    projectHome: opts.projectHome,
    inheritProjectInstructions: opts.inheritProjectInstructions,
    inheritProjectMemory: opts.inheritProjectMemory,
  });
  const currentMemories = () =>
    loadMemories({
      globalPath: globalMemoryPath,
      projectPath: inheritedProjectMemoryPath(
        projectDir,
        opts.projectHome,
        opts.inheritProjectMemory !== false,
      ),
    });

  const {
    registry: skillRegistry,
    hint: skillsHint,
    warnings: skillWarnings,
  } = await bootstrapSkills({
    startDir: projectDir,
    globalDir,
    projectHome: opts.projectHome,
    enabled: config.skills.enabled,
  });
  for (const w of skillWarnings) console.error(`[cleetus acp] WARNING: ${w}`);
  const workflowCreatorSkill = skillRegistry.get("workflow-creator");
  const workflowController = new WorkflowCommandController(
    workflowRuntime.service,
    workflowCreatorSkill
      ? {
          creator: new WorkflowCreatorController(
            new WorkflowDraftStore(join(projectDir, ".cleetus", "workflows")),
            new StructuredWorkflowCreatorModel(
              new WorkflowModelCallService((name) => providers.get(name)),
              () => ({
                provider: currentSessionConfig().active.provider,
                model: currentSessionConfig().active.model,
              }),
            ),
            composeSkillBody(workflowCreatorSkill),
            (packageDir, scope) =>
              workflowRuntime.stepRegistry(loadWorkflowPackage(packageDir, scope)),
          ),
          activate(draft, replace) {
            const activeRoot =
              draft.scope === "global"
                ? join(globalDir, "workflows")
                : join(projectDir, ".cleetus", "workflows");
            return activateWorkflowDraft({
              draftPackageDir: join(
                projectDir,
                ".cleetus",
                "workflows",
                ".drafts",
                draft.id,
                "package",
                draft.name!,
              ),
              activeRoot,
              scope: draft.scope,
              steps: (packageDir) =>
                workflowRuntime.stepRegistry(loadWorkflowPackage(packageDir, draft.scope)),
              registry: workflowRuntime.registry,
              replace,
              expectedBase: draft.revisionBase,
            });
          },
          record(context, type, payload) {
            if (!context.sessionId) return;
            log.append({
              sessionId: context.sessionId,
              type,
              payload: {
                ...payload,
                text: `Workflow creator: ${String(payload.kind ?? type)}`,
                level: type === "error" ? "error" : "info",
                visibility: "verbose",
              },
            });
          },
        }
      : undefined,
  );

  // Session-pinned clock: the system prompt must stay byte-stable for the whole session so the
  // provider's KV prefix cache survives (audit F3). A session spanning midnight keeps the stale
  // date by design. Fresh sessions get a fresh date because this runs once per process.
  const sessionClock = new Date();
  const personaOverride = await loadSystemPromptOverride(config.systemPromptFile);
  const systemPrompt = () =>
    buildSystemPrompt({
      personaPrompt: personaOverride ?? personaInfo(currentSessionConfig().persona).prompt,
      overlay: overlayFor(currentSessionConfig().personality),
      environment: [
        renderEnvironment(
          projectServiceHolder.current?.cwd ?? projectDir,
          process.platform,
          sessionClock,
        ),
        scope.artifact,
      ]
        .filter(Boolean)
        .join("\n"),
      instructions: scope.instructions,
      repoMap: projectServiceHolder.current?.repoMap ?? "",
      skills: skillsHint,
      memories: currentMemories(),
    });
  const smallSystemPrompt = () =>
    buildSystemPrompt({
      personaPrompt: personaOverride ?? personaPrompt(currentSessionConfig().persona, "small"),
      overlay: overlayFor(currentSessionConfig().personality),
      environment: [
        renderEnvironment(
          projectServiceHolder.current?.cwd ?? projectDir,
          process.platform,
          sessionClock,
        ),
        scope.artifact,
      ]
        .filter(Boolean)
        .join("\n"),
      instructions: scope.instructions,
      repoMap: truncateMapToBudget(
        projectServiceHolder.current?.repoMap ?? "",
        Math.floor(
          (projectServiceHolder.current?.config.repoMap.tokenBudget ?? config.repoMap.tokenBudget) /
            2,
        ),
      ),
      skills: skillsHint,
      memories: currentMemories(),
    });

  const { value: maxToolLoops } = resolveMaxToolLoops(undefined, config.maxToolLoops);

  // Mutable plan-mode flag — `session/set_mode` flips it; the runtime reads the live value.
  const planModeHolder: PlanModeHolder = { current: false };

  // Chat routing parity (#225): honor config.routing (manual/speed/smart) like the terminal.
  // The launch value becomes each session's default; ACP config options can change it later.
  // Warnings (e.g. speed/smart without tiers → manual) share the startup warning channel.
  const {
    router: acpRouter,
    mode: routeMode,
    warnings: routeWarnings,
  } = buildAcpRouter(config.routing, { provider: providerName, model }, opts.route, {
    getMode: () => currentSessionConfig().route,
    getActive: () => currentSessionConfig().active,
  });
  for (const w of routeWarnings) console.error(`[cleetus acp] WARNING: ${w}`);
  const sessionConfig = createAcpSessionConfig({
    defaults: {
      active: { provider: providerName, model },
      persona: personaId,
      personality: personalityId,
      effort: effortLevel,
      route: routeMode,
      maxToolLoops,
    },
    catalog,
    routingTiersAvailable: config.routing.tiers !== undefined,
    holder: activeSessionHolder,
    onActiveChange: (choice) => void modelContext.prime([choice]),
  });
  sessionConfigRef.current = sessionConfig;
  // Resolve the active model and every possible first-turn routing target before accepting a
  // prompt. This avoids serving a cold large local model the reduced small-model surface merely
  // because `/api/ps` did not list it yet; ModelContextCache falls back to its architectural probe.
  await modelContext.prime([
    { provider: providerName, model },
    ...Object.values(config.routing.tiers ?? {}),
  ]);

  const runtimeOptions: AgentRuntimeOptions = {
    providers,
    tools,
    dispatcher,
    log,
    router: acpRouter,
    systemPrompt,
    effort: () => currentSessionConfig().effort,
    projectDir: () => projectServiceHolder.current?.cwd ?? projectDir,
    completionAudit: true,
    resolvePermission: (req) => permissionRouter.current(req),
    maxToolLoops: () => currentSessionConfig().maxToolLoops,
    context: () => config.context,
    historyStore,
    diagnostics: projectAdapters.diagnostics,
    formatter: projectAdapters.formatter,
    hooks: projectAdapters.hooks,
    checkpoints: projectAdapters.checkpoints,
    planMode: () => planModeHolder.current,
    modelContextLength: (requestedModel?: string, requestedProvider?: string) => {
      const active = currentSessionConfig().active;
      return modelContext.get(requestedProvider ?? active.provider, requestedModel ?? active.model);
    },
    modelContextInfo: (requestedModel?: string, requestedProvider?: string) => {
      const active = currentSessionConfig().active;
      return modelContext.getInfo(
        requestedProvider ?? active.provider,
        requestedModel ?? active.model,
      );
    },
    structuredOutput: () => config.structuredOutput ?? "auto",
    capability: () => config.capability,
    modelProfile: (model, provider) => config.modelProfiles?.[provider]?.[model],
    smallSystemPrompt,
    voiceReminder: () => voiceTurnReminder(currentSessionConfig().personality),
    voiceCorrection: (text) =>
      gatedVoiceCorrection(config.personalityCorrection, currentSessionConfig().personality, text),
    triggeredSkillReminders: (userInput) =>
      config.skills.enabled && config.skills.autoInvoke
        ? triggeredSkills(skillRegistry.list(), userInput).map((skill) => ({
            name: skill.name,
            reminder: renderSkillReminder(skill),
          }))
        : [],
  };
  const runtime = new AgentRuntime(runtimeOptions);
  const spawnSubagent = buildSubagentSpawner(runtimeOptions);

  const learnPlaybooks = new Map<string, LearnPlaybookController>();
  const learnPlaybookForSession = (sessionId: string): LearnPlaybookController => {
    const existing = learnPlaybooks.get(sessionId);
    if (existing) return existing;
    const service = new LearnPlaybookService({
      events: log,
      eventSink: log,
      getSessionId: () => sessionId,
      providers,
      getActive: () => sessionConfig.ensure(sessionId).active,
      skills: skillRegistry,
      // Swift chat sessions run from app-owned scratch directories. An explicit project home is
      // the durable project scope and therefore the only correct target for `save project`.
      projectDir: opts.projectHome ?? projectDir,
      globalDir,
      skillsEnabled: config.skills.enabled,
      autoInvoke: config.skills.autoInvoke,
      structuredOutput: (config.structuredOutput ?? "auto") === "auto",
      modelFamily: config.modelFamily,
    });
    learnPlaybooks.set(sessionId, service);
    return service;
  };
  const buildSpecSeed = (idea: string): string | undefined => {
    const skill = skillRegistry.get("spec-creator");
    if (!skill) return undefined;
    return buildSpecTurn({
      playbookBody: composeSkillBody(skill),
      specsDir: config.specs.dir,
      datePrefix: specDatePrefix(new Date()),
      idea,
      orchestrationAvailable: false,
    });
  };
  const getActiveProject = () => projectServiceHolder.current;
  const getCheckpoints = (sessionId: string): CheckpointSummary[] =>
    getActiveProject()?.checkpoints?.list(sessionId) ?? [];
  const rewindToCheckpoint = async (sessionId: string, turnNumber: number): Promise<boolean> => {
    const outcome = await getActiveProject()?.checkpoints?.rewindTo(sessionId, turnNumber);
    if (!outcome) return false;
    runtime.truncateHistory(sessionId, outcome.historyLength);
    const { cleared } = runtime.restoreTodos(sessionId, outcome.todos);
    runtime.snapshotSession(sessionId);
    log.append({
      sessionId,
      type: "turn_reverted",
      payload: {
        turnNumber,
        userInput: outcome.userInput,
        revertedTurns: outcome.revertedTurns,
        filesRestored: outcome.filesRestored,
        filesDeleted: outcome.filesDeleted,
        todos: outcome.todos,
        todosCleared: cleared,
        filesRestoreSkipped: outcome.filesRestoreSkipped ?? false,
      },
    });
    return true;
  };
  const runInsights = (sessionId: string, args: string, signal?: AbortSignal) =>
    runAcpInsights({
      source: log,
      sessionId,
      args,
      signal,
      explain: () => {
        const active = sessionConfig.ensure(sessionId).active;
        return { provider: providers.get(active.provider), model: active.model };
      },
    });
  const runAcpReview = async (
    sessionId: string,
    args: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const project = getActiveProject();
    if (!project) return "review failed: no active ACP project";
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const messages = runtime.getMessages(sessionId);
    const intent = lastUserRequest(
      messages.map((message) => ({
        role: message.role,
        content: stripSystemReminders(message.content),
      })),
    );
    const printed: string[] = [];
    try {
      await runReview(
        args.split(/\s+/).filter(Boolean),
        {
          git: (argv) =>
            runGit(delegatingSandbox, argv, {
              projectDir: project.cwd,
              abortSignal: controller.signal,
            }),
          spawn: (prompt, reviewSignal) =>
            spawnSubagent({ type: "review", prompt, signal: reviewSignal }).then(
              (result) => result.assistantText,
            ),
          emitFindings: (markdown) => {
            runtime.seedReviewFindings(sessionId, markdown);
            runtime.snapshotSession(sessionId);
          },
          intent,
          signal: controller.signal,
        },
        (line) => printed.push(line),
      );
      return printed.length > 0 ? printed.join("\n") : undefined;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
  const runIndex = async (
    _sessionId: string,
    args: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    const project = getActiveProject();
    if (!project) return "index failed: no active ACP project";
    const action = args.trim().toLowerCase();
    if (action && action !== "rebuild") return "usage: /index [rebuild]";
    if (!project.vectors.enabled) {
      return "embeddings not configured — add an `embeddings` block to config.yaml";
    }
    if (signal?.aborted) return "index cancelled";
    try {
      const summary = await project.indexer.run({ rebuild: action === "rebuild" });
      if (signal?.aborted) return "index cancelled";
      const modelNote =
        summary.rebuilt && action !== "rebuild"
          ? "embedding model changed — rebuilt from scratch\n"
          : "";
      return `${modelNote}indexed ${summary.indexedFiles} files (${summary.indexedChunks} chunks) · ${summary.skipped} unchanged · ${summary.removed} removed · ${(summary.elapsedMs / 1000).toFixed(1)}s`;
    } catch (error) {
      return `index failed: ${(error as Error).message}`;
    }
  };

  const dispose = async () => {
    learnPlaybooks.clear();
    projectServices.dispose();
    await configuredMcp.shutdown();
    toolset.dispose();
    await realSandbox.dispose();
    log.close();
    db.close();
  };

  return {
    runtime,
    log,
    projectDir,
    launchScope,
    vision: config.vision,
    resize: config.resize,
    provider: providerName,
    model,
    permissionRouter,
    fileBridgeHolder,
    sandboxHolder,
    realSandbox,
    historyStore,
    tools,
    configuredMcp: {
      names: configuredMcp.names,
      statuses: configuredMcp.statuses,
    },
    skills: skillRegistry,
    learnPlaybookForSession,
    buildSpecSeed,
    instructions: scope.instructions,
    memory,
    planModeHolder,
    sessionConfig,
    activeSessionHolder,
    projectContext: {
      activate: async (cwd) => {
        projectServiceHolder.current = await projectServices.get(cwd);
      },
      reset: () => {
        projectServiceHolder.current = undefined;
      },
    },
    projectCommands: {
      getCheckpoints,
      rewindToCheckpoint,
      runInsights,
      runReview: runAcpReview,
      runIndex,
    },
    workflowController,
    workflowAuthorizationRouter,
    rulesForCwd,
    degradedConsent,
    dispose,
  };
}
