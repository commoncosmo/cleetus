#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Command } from "commander";
import { ulid } from "ulid";
import { version } from "../../package.json";
import { isAcpInvocation } from "../acp/invocation";
import { stampActor } from "../agent/actor-log";
import { maybeGcOnStartup } from "../agent/attachment-gc";
import {
  extractImageCandidates,
  isRootedPath,
  resolveAttachmentPaths,
  stageImages,
} from "../agent/attachments";
import { makeVerifyQuality } from "../agent/build-gate/quality";
import { makeVerifyBuild } from "../agent/build-gate/wire";
import { inspectProject } from "../agent/config-doctor-scan";
import { type EffortLevel, resolveStartEffort } from "../agent/effort";
import { renderArtifactGrounding, renderEnvironment } from "../agent/environment";
import {
  MAIN_INSTR_LEAD,
  emphasizeInstructions,
  instructionSourcePaths,
  loadInstructions,
} from "../agent/instructions";
import { Orchestrator } from "../agent/orchestrator";
import {
  type PersonalityId,
  gatedVoiceCorrection,
  overlayFor,
  resolveStartPersonality,
  voiceTurnReminder,
} from "../agent/personalities";
import { type PersonaId, personaInfo, personaPrompt, resolveStartPersona } from "../agent/personas";
import { projectAuditDbPath, projectCheckpointMirrorDir } from "../agent/recovery-path";
import { lastUserRequest, runReview } from "../agent/review";
import { type RouteMode, resolveStartRouteMode } from "../agent/route-modes";
import { type Router, createRouter } from "../agent/router";
import { AgentRuntime, type AgentRuntimeOptions } from "../agent/runtime";
import { type Session, SessionStore } from "../agent/session";
import { ensureParentDir, resolveSessionDbPath } from "../agent/session-db-path";
import { SessionHistoryStore } from "../agent/session-history";
import { sessionPreview } from "../agent/session-preview";
import { buildSpecTurn, specDatePrefix } from "../agent/spec";
import { buildOrchestrationWorkerSpawner, buildSubagentSpawner } from "../agent/subagent";
import { buildSystemPrompt } from "../agent/system-prompt";
import { loadSystemPromptOverride } from "../agent/system-prompt-override";
import { latestUnfinishedTodos } from "../agent/todo-snapshot";
import { inheritedProjectMemoryPath, projectMemoryPath } from "../agent/tui-project-scope";
import { buildCheckpointStore } from "../checkpoint/index";
import { Indexer } from "../codeindex/indexer";
import { Manifest } from "../codeindex/manifest";
import { CodeSearchTool } from "../codeindex/search-tool";
import { readAppState, writeAppState } from "../config/app-state";
import { resolveConfigRoot } from "../config/config-root";
import { applyLaunchOverrides } from "../config/launch-overrides";
import { type LaunchScope, establishLaunchScope } from "../config/launch-scope";
import { loadConfig } from "../config/loader";
import { resolveMaxToolLoops } from "../config/loop-cap";
import {
  createScratchDir,
  reapStaleScratchDirs,
  registerScratchCleanup,
} from "../config/scratch-lifecycle";
import { buildDiagnosticsManager } from "../diagnostics/index";
import { launchEditor } from "../editor/launch";
import {
  confineEditorCreation,
  confinedEditorRoot,
  confinedEditorTarget,
  confinedEditorTree,
} from "../editor/paths";
import { EventLog } from "../events/log";
import { buildFormatter } from "../format/manager";
import { runGit } from "../git/run";
import { buildHookEngine } from "../hooks";
import { LearnPlaybookService } from "../learn/service";
import { openDatabase } from "../lib/db";
import { CleetusError } from "../lib/errors";
import { McpManager, createStdioConnection } from "../mcp";
import type { NamedServerConfig } from "../mcp/types";
import { loadMemories } from "../memory/load";
import { RememberTool } from "../memory/remember-tool";
import { MemoryStore } from "../memory/store";
import { stripBashAllowRules } from "../permission/degraded";
import { evaluatePermission, evaluateRules } from "../permission/evaluator";
import { loadPermissions } from "../permission/loader";
import { type PermissionMode, nextPriorMode } from "../permission/modes";
import {
  resolveReadTarget,
  resolveToolTargetPath,
  writeEscapesProject,
} from "../permission/path-guard";
import type { Decision } from "../permission/types";
import { catalogEntries, fetchCatalog, renderCatalog } from "../providers/catalog";
import { buildProvider } from "../providers/factory";
import { ModelContextCache } from "../providers/model-context-cache";
import { lowContextWarning } from "../providers/native-context";
import { providerReadinessWarnings } from "../providers/readiness";
import { ProviderRegistry } from "../providers/registry";
import { resolveStartupChoice } from "../providers/startup";
import { NoResponseFormatMemo, isNoResponseFormatError } from "../providers/structured-output";
import { gateVision } from "../providers/vision";
import { buildRepoMap } from "../repomap/build";
import { truncateMapToBudget } from "../repomap/render";
import { unconfinedSandboxNotice } from "../sandbox/boundary";
import { createSandboxWithInfo } from "../sandbox/factory";
import { spawnCollect } from "../sandbox/spawn";
import { isSecretPath } from "../security/secret-paths";
import { firstRunSetup } from "../setup/first-run";
import { bootstrapSkills } from "../skills/bootstrap";
import { composeSkillBody, renderSkillReminder, stripSystemReminders } from "../skills/compose";
import { orchestrationSkillDeps } from "../skills/orchestration";
import { triggeredSkills } from "../skills/trigger";
import type { Skill } from "../skills/types";
import { buildCommandRegistry } from "../slash/commands";
import { ApplyPatchTool } from "../tools/apply-patch/tool";
import { BashTool } from "../tools/bash";
import { ToolDispatcher } from "../tools/dispatcher";
import { EditFileTool } from "../tools/edit-file";
import { buildGitTools } from "../tools/git/index";
import { GlobTool } from "../tools/glob";
import { GrepTool } from "../tools/grep";
import { MultiEditTool } from "../tools/multi-edit";
import { ReadFileTool } from "../tools/read-file";
import { ToolRegistry } from "../tools/registry";
import { RenderCheckTool } from "../tools/render-check/index";
import { RequestEscalationTool } from "../tools/request-escalation";
import { RunTestsTool, buildTestRunner } from "../tools/run-tests/index";
import { RunWorkflowTool } from "../tools/run-workflow";
import { SaveFetchedJsonTool } from "../tools/save-fetched-json";
import { ScaffoldTool } from "../tools/scaffold";
import { SmokeRunTool } from "../tools/smoke-run/index";
import { SubagentTool } from "../tools/subagent/tool";
import {
  TodoListDeleteTool,
  TodoListLoadTool,
  TodoListSaveTool,
  TodoListShowTool,
  TodoListWriteTool,
} from "../tools/todo-list";
import { TodoListStore } from "../tools/todo-list-store";
import { TodoWriteTool } from "../tools/todo-write";
import { WebFetchTool } from "../tools/web-fetch";
import { WebSearchTool } from "../tools/web-search";
import { WriteFileTool } from "../tools/write-file";
import { runOneShot } from "../ui/cli/one-shot";
import { ROOT_COMMAND_HELP } from "../ui/cli/root-help";
import { type RequestWorkflowAuthorization, formatManualWorkflowReview } from "../ui/cli/workflow";
import { ThemeProvider, resolveTheme } from "../ui/theme";
import { createFrameWriter, syncOutputEnabled } from "../ui/tui/frame-writer";
import { formatOrchestrationRoles } from "../ui/tui/model-roster";
import { createRenderDebugSink, renderDebugEnabled } from "../ui/tui/render-debug";
import { type SessionRow, sessionRows } from "../ui/tui/session-row";
import { Embedder } from "../vector/embedder";
import { VectorService } from "../vector/service";
import { WebFetchCache } from "../web/fetch-cache";
import { activateWorkflowDraft } from "../workflows/creator/activate";
import { WorkflowCreatorController } from "../workflows/creator/controller";
import { WorkflowDraftStore } from "../workflows/creator/draft-store";
import { StructuredWorkflowCreatorModel } from "../workflows/creator/model";
import { WorkflowCommandController } from "../workflows/interactive-controller";
import {
  beginManualWorkflowRevision,
  discardManualWorkflowDraft,
  loadManualWorkflowDraft,
  publishManualWorkflowDraft,
  reviewManualWorkflowDraft,
} from "../workflows/manual-authoring";
import { WorkflowModelCallService } from "../workflows/model-call";
import { loadWorkflowPackage } from "../workflows/package";
import { renderWorkflowPromptHint } from "../workflows/prompt";
import type { JsonObject, JsonSchema } from "../workflows/types";
import { makeCrashHandler } from "./crash-handler";

interface ProgramOptions {
  provider?: string;
  model?: string;
  fuckit?: boolean;
  resume?: string | boolean;
  fork?: string;
  sessionId?: string;
  sessionDb?: string;
  configDir?: string;
  projectDir?: string;
  global?: boolean;
  scratch?: boolean;
  projectInstructions?: boolean;
  projectMemory?: boolean;
  listModels?: boolean;
  json?: boolean;
  route?: string;
  routeSmallProvider?: string;
  routeSmallModel?: string;
  routeLargeProvider?: string;
  routeLargeModel?: string;
  orchestrate?: string;
  orchestratorProvider?: string;
  orchestratorModel?: string;
  workerProvider?: string;
  workerModel?: string;
  maxLoops?: string;
  persona?: string;
  effort?: string;
  personality?: string;
  verbose?: boolean;
  hooks?: boolean; // commander sets false when --no-hooks is passed; default true
  image?: string[];
}

async function main(argv: string[]): Promise<number> {
  if (argv[2] === "workflow") {
    const { runWorkflowCli } = await import("../ui/cli/workflow");
    return runWorkflowCli(argv, process.cwd(), {
      write: (value) => process.stdout.write(value),
      writeErr: (value) => process.stderr.write(value),
    });
  }

  // `cleetus analyze ...` is a self-contained read-only subcommand: no TUI/MCP/provider boot.
  if (argv[2] === "analyze") {
    const { runAnalyze } = await import("../ui/cli/analyze");
    return runAnalyze(argv, process.cwd(), {
      write: (s) => process.stdout.write(s),
      writeErr: (s) => process.stderr.write(s),
    });
  }

  // `cleetus attachments gc [--dry-run]` — self-contained orphan-only attachment sweep (no boot).
  if (argv[2] === "attachments") {
    const { runAttachments } = await import("../ui/cli/attachments");
    return runAttachments(argv, process.cwd(), {
      write: (s) => process.stdout.write(s),
      writeErr: (s) => process.stderr.write(s),
    });
  }

  // `cleetus eval ...` is a self-contained subcommand (no TUI/MCP boot).
  if (argv[2] === "eval") {
    const { runEval } = await import("../ui/cli/eval");
    return runEval(argv, process.cwd(), {
      write: (s) => process.stdout.write(s),
      writeErr: (s) => process.stderr.write(s),
    });
  }

  // `cleetus improve ...` is a self-contained subcommand (no TUI/MCP boot).
  if (argv[2] === "improve") {
    const { runImprove } = await import("../ui/cli/improve");
    return runImprove(argv, process.cwd(), {
      write: (s) => process.stdout.write(s),
      writeErr: (s) => process.stderr.write(s),
    });
  }

  // `cleetus acp` runs as a headless Agent Client Protocol agent (no TUI boot). Dispatched here
  // like analyze/eval/improve — NOT as a commander `.command("acp")`, which would turn the root
  // into a command container and break the default `[prompt...]` invocation (bare → help,
  // `cleetus "<prompt>"` → unknown-command). Its own `--provider`/`--model` are parsed from the
  // post-`acp` args; everything else cleetus reads from config.
  if (isAcpInvocation(argv)) {
    const { parseAcpOptions } = await import("../acp/cli");
    const { runAcp } = await import("../acp/server");
    await runAcp(parseAcpOptions(argv));
    return 0;
  }

  const program = new Command();
  program
    .name("cleetus")
    .description("Local-model agentic coding assistant")
    .argument("[prompt...]", "one-shot prompt; omit to enter interactive TUI")
    .option(
      "--image <path>",
      "attach an image (repeatable); requires a vision-capable model",
      (v, acc: string[]) => [...acc, v],
      [],
    )
    .option("--provider <name>", "override provider")
    .option("--model <name>", "override model")
    .option("--fuckit", "disable permission prompts (DANGEROUS)")
    .option("--no-hooks", "disable PreToolUse/PostToolUse hooks for this run")
    .option("--route <mode>", "routing mode: manual | speed | smart")
    .option("--route-small-provider <name>", "routing small-tier provider")
    .option("--route-small-model <name>", "routing small-tier model")
    .option("--route-large-provider <name>", "routing large-tier provider")
    .option("--route-large-model <name>", "routing large-tier model")
    .option("--orchestrate <state>", "orchestration: on | off")
    .option("--orchestrator-provider <name>", "orchestrator model provider")
    .option("--orchestrator-model <name>", "orchestrator model")
    .option("--worker-provider <name>", "worker subagent provider")
    .option("--worker-model <name>", "worker subagent model")
    .option(
      "--max-loops <n>",
      "optional model round-trip limit per turn (0 = unlimited; default unlimited)",
    )
    .option("--persona <id>", "system-prompt persona: coding | chat | concise | general")
    .option("--effort <level>", "reasoning effort: low | medium | high")
    .option("--personality <id>", "voice overlay: neutral | cleetus | bofh")
    .option("--verbose", "show warning and internal diagnostic notices")
    .option("--resume [id]", "resume a session (no id opens a picker)")
    .option(
      "--session-id <id>",
      "use a specific session id (create it if new, resume it if it exists)",
    )
    .option(
      "--session-db <path>",
      "use a specific session database file (overrides the per-directory default)",
    )
    .option("--config-dir <path>", "use a specific config directory (default ~/.config/cleetus)")
    .option(
      "--project-dir <path>",
      "project-home scope anchor (memory/instructions/artifacts), distinct from cwd",
    )
    .option("--global", "operate against the persistent global workspace (default ~/.cleetus)")
    .option("--scratch", "operate against a fresh ephemeral directory, deleted on exit")
    .option("--no-project-instructions", "do not inherit the project's instructions")
    .option("--no-project-memory", "do not inherit the project's memory")
    .option("--fork <id>", "start a new session branched from an existing one")
    .option("--list-models", "list models from all configured providers and exit")
    .option("--json", "with --list-models, output the catalog as JSON")
    .version(version)
    .addHelpText("after", ROOT_COMMAND_HELP)
    .allowExcessArguments();

  program.parse(argv);
  const opts = program.opts<ProgramOptions>();
  const promptArg = program.args.join(" ").trim();

  const launchCwd = realpathSync(process.cwd());
  const GLOBAL_DIR = resolveConfigRoot(opts.configDir, homedir(), process.cwd());
  const GLOBAL_CONFIG = join(GLOBAL_DIR, "config.yaml");
  const GLOBAL_PERMS = join(GLOBAL_DIR, "permissions.yaml");
  const GLOBAL_INSTR = join(GLOBAL_DIR, "instructions.md");
  const GLOBAL_MEMORY = join(GLOBAL_DIR, "memory.md");
  // Load the global config first (it is where global_workspace_dir lives) to pick the scope dir,
  // then chdir, then load the merged config from the now-correct project dir.
  const preConfig = await loadConfig({ globalPath: GLOBAL_CONFIG, projectDir: launchCwd });
  // global_workspace_dir must be cwd-independent (spec §D): read it from the global config alone,
  // not the cwd-merged preConfig where a project .cleetus/config.yaml could shadow it.
  const globalWorkspaceDir = opts.global
    ? (await loadConfig({ globalPath: GLOBAL_CONFIG, projectDir: GLOBAL_DIR })).globalWorkspaceDir
    : undefined;
  const scope: LaunchScope = establishLaunchScope(
    {
      global: opts.global ?? false,
      scratch: opts.scratch ?? false,
      cwd: launchCwd,
      projectHome: opts.projectDir,
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
  const projectHome = scope.kind === "project" ? opts.projectDir : undefined;
  const inheritProjectInstructions = opts.projectInstructions ?? true;
  const inheritProjectMemory = opts.projectMemory ?? true;
  let config =
    scope.kind === "project"
      ? preConfig
      : await loadConfig({ globalPath: GLOBAL_CONFIG, projectDir });

  // First run (no provider configured): auto-detect a local server and continue, or scaffold and exit.
  if (Object.keys(config.providers).length === 0) {
    const fr = await firstRunSetup(config, GLOBAL_DIR);
    console.error(`[cleetus] ${fr.message}`);
    if (fr.action === "exit") return 0;
    config = fr.config;
  }

  // Overlay per-launch routing tiers + orchestration from flags (flag > config). Routing mode
  // (`--route`) is still resolved by resolveStartRouteMode below; this overlays the tier + the
  // orchestration enabled/model pieces the terminal path consumes.
  {
    const { config: overlaid, warnings: overlayWarnings } = applyLaunchOverrides(config, {
      routeSmallProvider: opts.routeSmallProvider,
      routeSmallModel: opts.routeSmallModel,
      routeLargeProvider: opts.routeLargeProvider,
      routeLargeModel: opts.routeLargeModel,
      orchestrate: opts.orchestrate,
      orchestratorProvider: opts.orchestratorProvider,
      orchestratorModel: opts.orchestratorModel,
      workerProvider: opts.workerProvider,
      workerModel: opts.workerModel,
    });
    config = overlaid;
    for (const w of overlayWarnings) console.error(`[cleetus] WARNING: ${w}`);
  }

  const providers = new ProviderRegistry();
  for (const [name, p] of Object.entries(config.providers)) {
    providers.register(name, buildProvider(p.type, p.baseUrl, p.apiKey));
  }
  const modelContext = new ModelContextCache(providers);

  // --list-models: print the cross-provider catalog and exit, no side effects.
  if (opts.listModels) {
    const catalog = await fetchCatalog(providers);
    process.stdout.write(`${renderCatalog(catalog, { json: opts.json ?? false })}\n`);
    return 0;
  }

  mkdirSync(join(projectDir, ".cleetus"), { recursive: true });
  mkdirSync(GLOBAL_DIR, { recursive: true });

  const memoryStores = {
    global: new MemoryStore(GLOBAL_MEMORY),
    project: new MemoryStore(projectMemoryPath(projectDir, projectHome)),
  };
  const todoListStores = {
    global: new TodoListStore(join(GLOBAL_DIR, "todos")),
    project: new TodoListStore(join(projectDir, ".cleetus", "todos")),
  };

  // Phase 2 — vector store + code index. Disabled gracefully when no embeddings config.
  let embedder: Embedder | null = null;
  if (config.embeddings) {
    if (providers.names().includes(config.embeddings.provider)) {
      embedder = new Embedder(providers.get(config.embeddings.provider), config.embeddings.model);
    } else {
      console.error(
        `[cleetus] WARNING: embeddings.provider '${config.embeddings.provider}' is not configured; code search disabled`,
      );
    }
  }
  const vectorService = new VectorService({
    projectDbPath: join(projectDir, ".cleetus", "vectors.db"),
    globalDbPath: join(GLOBAL_DIR, "vectors.db"),
    embedder,
  });
  const codeManifest = new Manifest(join(projectDir, ".cleetus", "code-index.db"));
  const indexer = new Indexer({
    projectDir,
    vectorService,
    manifest: codeManifest,
    embedModel: embedder?.model ?? "",
  });

  const rules = await loadPermissions({ globalPath: GLOBAL_PERMS, projectDir });

  const sessionsDbPath = resolveSessionDbPath(projectDir, opts.sessionDb);
  ensureParentDir(sessionsDbPath);
  const log = new EventLog(sessionsDbPath, {
    mirrorPath: projectAuditDbPath(GLOBAL_DIR, projectDir),
  });
  const db = openDatabase(sessionsDbPath);
  const sessions = new SessionStore(db);
  const historyStore = new SessionHistoryStore(db);
  maybeGcOnStartup(config.attachments, join(projectDir, ".cleetus", "attachments"), db, (line) =>
    process.stderr.write(`${line}\n`),
  );

  const mcpServers: NamedServerConfig[] = Object.entries(config.mcpServers).map(([name, s]) => ({
    name,
    ...s,
  }));
  const mcp = new McpManager({
    servers: mcpServers,
    factory: createStdioConnection,
    log,
    timeoutMs: 10_000,
  });

  // Resolve the startup (provider, model) across all providers. A configured or
  // flagged model that resolves skips the picker entirely; anything unresolved is
  // handled per-mode below (modal in the TUI, error/first-model in one-shot).
  const [catalog] = await Promise.all([fetchCatalog(providers), mcp.connectAll()]);
  const startup = resolveStartupChoice(catalog, {
    requestedProvider: opts.provider,
    requestedModel: opts.model,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
  });
  if (startup.kind === "error") {
    console.error(startup.message);
    await mcp.shutdown();
    vectorService.close();
    codeManifest.close();
    log.close();
    db.close();
    return 1;
  }

  const { sandbox, degraded: sandboxDegraded } = createSandboxWithInfo(config.sandbox, projectDir);
  let requestWorkflowAuthorization: RequestWorkflowAuthorization = async () => "deny";
  let collectWorkflowInputs: (request: {
    workflow: string;
    schema: JsonSchema;
  }) => Promise<JsonObject> = async () => {
    throw new Error("interactive workflow input collection is unavailable");
  };
  const { buildWorkflowService } = await import("../ui/cli/workflow");
  const workflowRuntime = await buildWorkflowService({
    projectDir,
    configDir: GLOBAL_DIR,
    execution: true,
    runtime: {
      sandbox,
      providers,
      defaultProvider: startup.kind === "ready" ? startup.provider : config.defaultProvider,
      defaultModel: startup.kind === "ready" ? startup.model : config.defaultModel,
    },
    requestAuthorization: (request) => requestWorkflowAuthorization(request),
    events: {
      emit(event) {
        log.append({
          sessionId: session.id,
          type: "workflow_status",
          payload: { workflowEvent: event },
        });
      },
    },
  });
  const appState = sandboxDegraded ? await readAppState(GLOBAL_DIR) : {};
  const degradedConsent = { acked: appState.sandboxDegradedAck === true };

  const tools = new ToolRegistry();
  tools.register(new ReadFileTool());
  tools.register(new WriteFileTool());
  tools.register(new EditFileTool());
  tools.register(new MultiEditTool());
  tools.register(new ApplyPatchTool());
  tools.register(new TodoWriteTool());
  tools.register(new TodoListShowTool(todoListStores));
  tools.register(new TodoListWriteTool(todoListStores));
  tools.register(new TodoListDeleteTool(todoListStores));
  tools.register(new TodoListSaveTool(todoListStores));
  tools.register(new TodoListLoadTool(todoListStores));
  tools.register(
    new BashTool(sandbox, { enforcePackageManager: config.packageManager.enforceBun }),
  );
  tools.register(new ScaffoldTool(sandbox));
  tools.register(new SmokeRunTool(sandbox, config.smokeRun));
  tools.register(
    new RenderCheckTool(sandbox, {
      timeoutMs: config.test.timeoutMs,
      maxOutputLines: config.test.maxOutputLines,
    }),
  );
  tools.register(new RunWorkflowTool(workflowRuntime.service));
  const { register: registerTests, resolve: resolveTests } = await buildTestRunner(
    config.test,
    projectDir,
    { registerForAnyProject: true },
  );
  if (registerTests) {
    tools.register(
      new RunTestsTool(sandbox, resolveTests, {
        timeoutMs: config.test.timeoutMs,
        maxOutputLines: config.test.maxOutputLines,
      }),
    );
  }
  const { tools: gitTools, warnings: gitWarnings } = await buildGitTools({ sandbox, projectDir });
  for (const w of gitWarnings) console.error(`[cleetus] WARNING: ${w}`);
  for (const t of gitTools) tools.register(t);
  tools.register(new GlobTool());
  tools.register(new GrepTool());
  tools.register(new RequestEscalationTool());
  const webFetchCache = new WebFetchCache();
  tools.register(new WebFetchTool(config.webTools, { cache: webFetchCache }));
  tools.register(new SaveFetchedJsonTool(webFetchCache));
  tools.register(new WebSearchTool(config.webTools));
  tools.register(new CodeSearchTool(vectorService));
  tools.register(new RememberTool(memoryStores, scope.defaultMemoryScope));
  mcp.registerInto(tools);

  // Degraded strip runs only after the FULL roster (built-ins + git tools + MCP) is registered,
  // so wildcard allow rules re-expand over every real tool. Nothing evaluates rules before this.
  if (sandboxDegraded)
    stripBashAllowRules(
      rules,
      tools.all().map((t) => t.name),
    );
  const dispatcher = new ToolDispatcher(tools);

  const instructionLoadOptions = {
    globalPath: GLOBAL_INSTR,
    startDir: projectDir,
    projectHome,
    includeProjectInstructions: inheritProjectInstructions,
  };
  let instructions = await loadInstructions(instructionLoadOptions);
  const memories = loadMemories({
    globalPath: GLOBAL_MEMORY,
    projectPath: inheritedProjectMemoryPath(projectDir, projectHome, inheritProjectMemory),
  });
  const { persona: startPersona, warnings: personaWarnings } = resolveStartPersona(
    config.defaultPersona,
    opts.persona,
  );
  for (const w of personaWarnings) console.error(`[cleetus] WARNING: ${w}`);
  const personaState = { id: startPersona };
  const personaOverride = await loadSystemPromptOverride(config.systemPromptFile);
  const { personality: startPersonality, warnings: personalityWarnings } = resolveStartPersonality(
    config.defaultPersonality,
    opts.personality,
  );
  for (const w of personalityWarnings) console.error(`[cleetus] WARNING: ${w}`);
  const personalityState = { id: startPersonality };
  const { effort: startEffort, warnings: effortWarnings } = resolveStartEffort(
    config.defaultEffort,
    opts.effort,
  );
  for (const w of effortWarnings) console.error(`[cleetus] WARNING: ${w}`);
  const effortState = { level: startEffort };
  // Repo-map: built once at startup for interactive sessions only. One-shot (`promptArg`)
  // is skipped to avoid latency + token cost on scripted invocations. Disabled => "".
  const repoMap =
    config.repoMap.enabled && !promptArg
      ? await buildRepoMap({ projectDir, tokenBudget: config.repoMap.tokenBudget })
      : "";
  // Skills: discover user-authored skills + built-ins once at startup. The registry is
  // always built so the /skill command works on built-ins even when disabled. Disabled =>
  // no discovery and an empty hint. The hint is also suppressed for one-shot (`promptArg`)
  // runs, since they can't run the interactive /skill command it would suggest.
  const {
    registry: skillRegistry,
    hint: skillsHint,
    warnings: skillWarnings,
  } = await bootstrapSkills({
    startDir: projectDir,
    globalDir: GLOBAL_DIR,
    projectHome,
    enabled: config.skills.enabled,
    suppressHint: Boolean(promptArg),
  });
  for (const w of skillWarnings) console.error(`[cleetus] WARNING: ${w}`);
  const { manager: diagnostics, warnings: diagWarnings } = await buildDiagnosticsManager(
    config.diagnostics,
    projectDir,
  );
  for (const w of diagWarnings) console.error(`[cleetus] WARNING: ${w}`);
  const formatter = await buildFormatter(config.format, {
    projectDir,
    deps: {
      which: (bin) => Bun.which(bin),
      fileExists: (p) => Bun.file(p).exists(),
      readFile: (p) => Bun.file(p).text(),
      spawn: (argv, opts) =>
        spawnCollect(argv, { cwd: opts.cwd, timeoutMs: 15000, signal: opts.signal }).then((r) => ({
          exitCode: r.exitCode,
        })),
    },
  });
  const hookEngine =
    opts.hooks === false ? undefined : buildHookEngine(config.hooks, { sandbox, log });
  const diagnosticsSeedController = new AbortController();
  diagnostics?.seed(diagnosticsSeedController.signal);
  const checkpointStore = await buildCheckpointStore(config.checkpoint, {
    sandbox,
    projectDir,
    db,
    mirrorDir: projectCheckpointMirrorDir(GLOBAL_DIR, projectDir),
  });
  // Session-pinned clock: the system prompt must stay byte-stable for the whole session so the
  // provider's KV prefix cache survives (audit F3). A session spanning midnight keeps the stale
  // date by design. Fresh sessions get a fresh date because this runs once per process.
  const sessionClock = new Date();
  const workflowHint = renderWorkflowPromptHint(workflowRuntime.service.list());
  const systemPrompt = () =>
    buildSystemPrompt({
      personaPrompt: personaOverride ?? personaInfo(personaState.id).prompt,
      overlay: overlayFor(personalityState.id),
      environment: [
        renderEnvironment(projectDir, process.platform, sessionClock),
        renderArtifactGrounding(projectHome),
      ]
        .filter(Boolean)
        .join("\n"),
      instructions: emphasizeInstructions(instructions, MAIN_INSTR_LEAD),
      repoMap,
      skills: [skillsHint, workflowHint].filter(Boolean).join("\n\n"),
      memories,
    });
  const smallSystemPrompt = () =>
    buildSystemPrompt({
      personaPrompt: personaOverride ?? personaPrompt(personaState.id, "small"),
      overlay: overlayFor(personalityState.id),
      environment: [
        renderEnvironment(projectDir, process.platform, sessionClock),
        renderArtifactGrounding(projectHome),
      ]
        .filter(Boolean)
        .join("\n"),
      instructions: emphasizeInstructions(instructions, MAIN_INSTR_LEAD),
      repoMap: truncateMapToBudget(repoMap, Math.floor(config.repoMap.tokenBudget / 2)),
      skills: [skillsHint, workflowHint].filter(Boolean).join("\n\n"),
      memories,
    });
  const permsDisabled = config.permissionsDisabled || Boolean(opts.fuckit);

  // Permission mode is runtime-toggleable in the TUI (via `/mode`). The resolver closure and the
  // shared `systemPrompt` closure both read `permState.mode` live, so flips take effect
  // immediately. Declared HERE — before the one-shot branch below — because one-shot invokes the
  // `systemPrompt` closure during its turn; with this object declared only in the interactive
  // setup further down, that read hit a TDZ ("Cannot access 'permState' before initialization").
  // Cast (not annotate) so the property type stays the full PermissionMode union — an
  // annotated const would be CFA-narrowed to "normal" | "fuckit" at the read site.
  const startMode = (permsDisabled ? "fuckit" : "normal") as PermissionMode;
  const permState = {
    mode: startMode,
    // Mirror the start mode so a --fuckit user who enters/approves a plan resumes at fuckit.
    priorMode: startMode,
    allowOutsideProject: false,
  };
  const routing = config.routing;
  const { mode: startRouteMode, warnings: routeWarnings } = resolveStartRouteMode(
    routing,
    opts.route,
  );
  for (const w of routeWarnings) console.error(`[cleetus] WARNING: ${w}`);
  const { value: maxToolLoops, warning: maxLoopsWarning } = resolveMaxToolLoops(
    opts.maxLoops,
    config.maxToolLoops,
  );
  if (maxLoopsWarning) console.error(`[cleetus] WARNING: ${maxLoopsWarning}`);
  const loopCapState = { value: maxToolLoops };

  // CLI ONE-SHOT
  if (promptArg) {
    // One-shot can't show a picker: a specified-but-unresolved model is a hard
    // error; an unspecified model falls back silently to the first available one.
    let providerName: string;
    let model: string;
    if (startup.kind === "ready") {
      providerName = startup.provider;
      model = startup.model;
    } else {
      if (startup.note) {
        console.error(`[cleetus] ${startup.note}`);
        diagnosticsSeedController.abort();
        await sandbox.dispose();
        await mcp.shutdown();
        vectorService.close();
        codeManifest.close();
        log.close();
        db.close();
        return 1;
      }
      const first = catalogEntries(catalog)[0]!;
      providerName = first.provider;
      model = first.model;
    }
    if (permsDisabled) console.error("[cleetus] WARNING: permissions disabled (--fuckit)");
    const oneShotUnconfinedNotice = unconfinedSandboxNotice(sandbox.writeRoot(), sandboxDegraded);
    if (oneShotUnconfinedNotice) console.error(`[cleetus] WARNING: ${oneShotUnconfinedNotice}`);
    // The first turn may route away from the configured active model. Resolve loaded or
    // architectural context evidence for every possible first-call choice before capability
    // selection, otherwise a cold routing tier is incorrectly served the small tool surface.
    await modelContext.prime([
      { provider: providerName, model },
      ...Object.values(routing.tiers ?? {}),
    ]);
    const oneShotContextWarning = lowContextWarning(
      model,
      modelContext.get(providerName, model),
      undefined,
      config.providers[providerName]?.type,
    );
    if (oneShotContextWarning) console.error(`[cleetus] WARNING: ${oneShotContextWarning}`);
    for (const warning of await providerReadinessWarnings(providers, providerName, model)) {
      console.error(`[cleetus] WARNING: ${warning}`);
    }
    const oneShotOpts: AgentRuntimeOptions = {
      providers,
      tools,
      dispatcher,
      log,
      router: createRouter({
        getMode: () => startRouteMode,
        getActive: () => ({ provider: providerName, model }),
        tiers: routing.tiers,
        smart: routing.smart,
      }),
      systemPrompt,
      projectDir,
      resolvePermission: async ({ tool, args, argsSummary }) => {
        // Both calls re-resolve the path; cheap here (realpath is OS-cached, once per tool
        // call) and non-write tools short-circuit before any I/O via rawToolPath.
        const escapes = await writeEscapesProject(tool, args, projectDir);
        const targetPath = await resolveToolTargetPath(tool, args, projectDir);
        const baseline = evaluatePermission(rules, tool, argsSummary, targetPath ?? undefined);
        // Explicit deny always wins
        if (baseline === "deny") return "deny";
        // WorkflowService performs the consolidated exact-revision authority check.
        if (tool === "run_workflow") return "allow";
        // Out-of-project read: one-shot cannot prompt; only an explicit rule allows (WS1).
        const read = await resolveReadTarget(tool, args, projectDir);
        if (read?.escapes) {
          // A secret-path read is refused inside the tool regardless of any grant — an
          // explicit pathPrefix allow rule cannot approve a secret read in one-shot.
          if (isSecretPath(read.target, homedir())) return "deny";
          const ruled = evaluateRules(rules, tool, argsSummary, read.target);
          if (ruled === "deny") return "deny"; // explicit deny holds even under --fuckit
          if (ruled !== "allow" && !permsDisabled) return "deny";
        }
        // Out-of-tree write: let the tool's boundary guard refuse with actionable guidance
        // (or write, if permissions are disabled), instead of a bare denial.
        if (escapes) return "allow";
        // Permissions disabled (fuckit or config)
        if (permsDisabled) return "allow";
        // Explicit allow
        if (baseline === "allow") return "allow";
        // ask → deny in one-shot (can't prompt)
        return "deny";
      },
      maxToolLoops: () => loopCapState.value,
      workerTurnTokens: config.orchestration.workerTurnTokens,
      workerProgressExtensionTokens: config.orchestration.workerProgressExtensionTokens,
      workerMaxTokenMultiplier: config.orchestration.workerMaxTokenMultiplier,
      workerNoProgressTokens: config.orchestration.workerNoProgressTokens,
      workerTurnMs: config.orchestration.workerTurnMs,
      workerThrashRepeats: () => config.orchestration.workerThrashRepeats,
      protectExistingFiles: () => config.orchestration.protectExistingFiles,
      guardPendingScope: () => config.orchestration.guardPendingScope,
      context: () => config.context,
      malformedPath: () => config.malformedPath,
      loopGuard: () => config.loopGuard,
      streamWatchdog: () => config.streamWatchdog,
      // Inert in one-shot (no planMode callback here); wired for parity with interactive.
      planModeGuard: () => config.planMode,
      modelContextLength: (m?: string, p?: string) =>
        modelContext.get(p ?? providerName, m ?? model),
      modelContextInfo: (m?: string, p?: string) =>
        modelContext.getInfo(p ?? providerName, m ?? model),
      effort: () => effortState.level,
      allowOutsideProject: () => permsDisabled,
      diagnostics,
      formatter,
      hooks: hookEngine,
      checkpoints: checkpointStore,
      historyStore,
      modelFamily: config.modelFamily,
      structuredOutput: () => config.structuredOutput ?? "auto",
      capability: () => config.capability,
      modelProfile: (model, provider) => config.modelProfiles?.[provider]?.[model],
      smallSystemPrompt,
      voiceReminder: () => voiceTurnReminder(personalityState.id),
      voiceCorrection: (text) =>
        gatedVoiceCorrection(config.personalityCorrection, personalityState.id, text),
      webToolsEnabled: () => config.webTools.enabled,
      completionAudit: true,
      triggeredSkillReminders: (userInput) =>
        config.skills.enabled && config.skills.autoInvoke
          ? triggeredSkills(skillRegistry.list(), userInput).map((skill) => ({
              name: skill.name,
              reminder: renderSkillReminder(skill),
            }))
          : [],
    };
    const runtime = new AgentRuntime(oneShotOpts);
    if (config.subagents.enabled) {
      tools.register(new SubagentTool(buildSubagentSpawner(oneShotOpts)));
    }

    // Attachments: `--image` flags and `@`-sigil paths in the prompt are explicit — their
    // resolution errors are surfaced. Bare image-extension tokens in the prompt are
    // auto-detected and split by confidence: rooted paths (absolute, `~/`, `./`, `../`) are a
    // strong signal the user meant a real file, so their errors are surfaced too; loose bare
    // filenames resolve silently (no error surfaced, only warnings). Each batch independently
    // enforces vision.maxPerTurn, so after merging via stageImages the combined total can exceed
    // the cap by up to 3x — truncate to the cap as a final backstop.
    const attachDir = join(projectDir, ".cleetus", "attachments");
    const flagPaths = opts.image ?? [];
    const { sigilPaths, autoPaths } = extractImageCandidates(promptArg);
    const explicitAttachments = await resolveAttachmentPaths(
      [...flagPaths, ...sigilPaths],
      config.vision,
      attachDir,
      config.resize,
    );
    const rootedAutoAttachments = await resolveAttachmentPaths(
      autoPaths.filter(isRootedPath),
      config.vision,
      attachDir,
      config.resize,
    );
    const looseAutoAttachments = await resolveAttachmentPaths(
      autoPaths.filter((p) => !isRootedPath(p)),
      config.vision,
      attachDir,
      config.resize,
    );
    for (const w of [
      ...explicitAttachments.warnings,
      ...rootedAutoAttachments.warnings,
      ...looseAutoAttachments.warnings,
    ]) {
      console.error(`[cleetus] WARNING: ${w}`);
    }
    for (const e of [...explicitAttachments.errors, ...rootedAutoAttachments.errors]) {
      console.error(`[cleetus] WARNING: ${e}`);
    }
    let attachments = stageImages(
      stageImages(explicitAttachments.refs, rootedAutoAttachments),
      looseAutoAttachments,
    );
    if (attachments.length > config.vision.maxPerTurn) {
      process.stderr.write(
        `[cleetus] WARNING: ${attachments.length} images exceeded the per-turn cap of ${config.vision.maxPerTurn}; attaching the first ${config.vision.maxPerTurn}\n`,
      );
      attachments = attachments.slice(0, config.vision.maxPerTurn);
    }
    if (attachments.length) {
      const support = (await providers.get(providerName).supportsVision?.(model)) ?? "unknown";
      const gate = gateVision(support, model, config.vision);
      if (gate.action === "block") {
        console.error(`[cleetus] ${gate.message}`);
        diagnosticsSeedController.abort();
        await sandbox.dispose();
        await mcp.shutdown();
        vectorService.close();
        codeManifest.close();
        log.close();
        db.close();
        return 2;
      }
      if (gate.action === "warn") console.error(`[cleetus] WARNING: ${gate.message}`);
    }

    const code = await runOneShot({
      runtime,
      log,
      sessions,
      provider: providerName,
      model,
      prompt: promptArg,
      write: (chunk) => {
        process.stdout.write(chunk);
      },
      // One-shot can't show a picker; honor --resume only when it carries an explicit id.
      resumeSessionId: typeof opts.resume === "string" ? opts.resume : undefined,
      historyStore,
      verbose: opts.verbose,
      attachments,
    });
    diagnosticsSeedController.abort();
    await sandbox.dispose();
    await mcp.shutdown();
    vectorService.close();
    codeManifest.close();
    log.close();
    db.close();
    return code;
  }

  // INTERACTIVE TUI
  const { render } = await import("ink");
  const React = await import("react");
  const { App } = await import("../ui/tui/app");

  const entries = catalogEntries(catalog);
  const ready = startup.kind === "ready";
  // No models at all: can't create a session — report and exit.
  if (!ready && entries.length === 0) {
    console.error("[cleetus] no models available from any configured provider");
    diagnosticsSeedController.abort();
    await sandbox.dispose();
    await mcp.shutdown();
    vectorService.close();
    codeManifest.close();
    log.close();
    db.close();
    return 1;
  }
  if (!ready && startup.note) console.error(`[cleetus] ${startup.note}`);

  // When not ready, start with a provisional (first) model so the session/runtime
  // can be built; the in-app picker opens on start and sets the real model before
  // any turn can run (input is disabled while the picker is open).
  const providerName = startup.kind === "ready" ? startup.provider : entries[0]!.provider;
  const chosenModel = startup.kind === "ready" ? startup.model : entries[0]!.model;
  const openModelPickerOnStart = !ready;

  // Resolve resume/fork at startup. `pendingSnapshot` is applied via runtime.loadSession
  // once the runtime exists (below). `--resume` with no id defers to the in-app picker.
  let openSessionPickerOnStart = false;
  // Snapshot to seed into the runtime once it exists (resume/fork). Null when starting fresh.
  let snapshotToLoad: ReturnType<SessionHistoryStore["load"]> | null = null;
  // `usedResumeOrFork` mirrors the old `opts.resume` guard: skip the unfinished-todo restore
  // offer whenever we are resuming or forking an existing conversation.
  let usedResumeOrFork = false;
  let session: Session;
  if (typeof opts.fork === "string") {
    const snap = historyStore.load(opts.fork);
    if (!snap) {
      console.error(`[cleetus] no saved history for session ${opts.fork} — cannot fork`);
      diagnosticsSeedController.abort();
      await sandbox.dispose();
      await mcp.shutdown();
      vectorService.close();
      codeManifest.close();
      log.close();
      db.close();
      return 1;
    }
    session = sessions.create({
      provider: providerName,
      model: chosenModel,
      title: `fork of ${opts.fork.slice(0, 8)}`,
    });
    historyStore.copy(opts.fork, session.id);
    snapshotToLoad = snap;
    usedResumeOrFork = true;
  } else if (typeof opts.sessionId === "string") {
    // App-dictated session id (desktop "Set folder" re-home): use this exact id —
    // resume it if it exists, else create a NEW session WITH this id, so the caller
    // can resume it later in a different working directory. (Differs from --resume,
    // which mints a fresh ulid when the id is unknown.)
    session =
      sessions.get(opts.sessionId) ??
      sessions.create({ id: opts.sessionId, provider: providerName, model: chosenModel });
    const snap = historyStore.load(opts.sessionId);
    if (snap) snapshotToLoad = snap;
    usedResumeOrFork = true;
  } else if (typeof opts.resume === "string") {
    session =
      sessions.get(opts.resume) ?? sessions.create({ provider: providerName, model: chosenModel });
    const snap = historyStore.load(opts.resume);
    if (snap) snapshotToLoad = snap;
    else console.error(`[cleetus] no saved history for session ${opts.resume} — starting fresh`);
    usedResumeOrFork = true;
  } else if (opts.resume === true) {
    openSessionPickerOnStart = true;
    session = sessions.create({ provider: providerName, model: chosenModel });
  } else {
    session = sessions.create({ provider: providerName, model: chosenModel });
  }

  const unconfinedNotice = unconfinedSandboxNotice(sandbox.writeRoot(), sandboxDegraded);
  if (unconfinedNotice) {
    log.append({
      sessionId: session.id,
      type: "notice",
      payload: { text: unconfinedNotice, level: "warn" },
    });
  }

  // Offer to restore the most recent prior session's unfinished todo list (interactive
  // TUI only; skipped when resuming/forking an existing conversation).
  const restoreCandidate = usedResumeOrFork
    ? null
    : latestUnfinishedTodos(log, { excludeSessionId: session.id });

  let resolverFn:
    | ((
        req: {
          tool: string;
          argsSummary: string;
          escapes?: boolean;
          targetPath?: string;
          readEscape?: boolean;
        },
        respond: (decision: Decision, grantOutside?: boolean) => void,
      ) => void)
    | null = null;
  let openModelPicker: (() => void) | null = null;
  let openRoutePicker: (() => void) | null = null;
  let stageImagePathsFn: ((paths: string[]) => Promise<void>) | null = null;
  let clearStagedImagesFn: (() => void) | null = null;
  let stageClipboardImageFn: (() => Promise<void>) | null = null;
  let notifyPersonaChanged: ((id: PersonaId) => void) | null = null;
  let openPersonaPicker: (() => void) | null = null;
  const setPersona = (id: PersonaId) => {
    personaState.id = id;
    notifyPersonaChanged?.(id);
  };
  let notifyPersonalityChanged: ((id: PersonalityId) => void) | null = null;
  let openPersonalityPicker: (() => void) | null = null;
  const setPersonality = (id: PersonalityId) => {
    personalityState.id = id;
    notifyPersonalityChanged?.(id);
  };
  let openEffortPicker: (() => void) | null = null;
  let notifyEffortChanged: ((level: EffortLevel) => void) | null = null;
  const setEffort = (level: EffortLevel) => {
    effortState.level = level;
    notifyEffortChanged?.(level);
  };
  let orchestrationEnabled = config.orchestration.enabled;
  let notifyOrchestrationChanged: ((enabled: boolean) => void) | null = null;
  const getOrchestrationEnabled = () => orchestrationEnabled;
  const setOrchestrationEnabled = (enabled: boolean) => {
    orchestrationEnabled = enabled;
    notifyOrchestrationChanged?.(enabled);
  };
  let openRewindPicker: (() => void) | null = null;

  const active = { provider: providerName, model: chosenModel };
  await modelContext.prime([active, ...Object.values(routing.tiers ?? {})]);
  {
    const w = lowContextWarning(
      active.model,
      modelContext.get(active.provider, active.model),
      undefined,
      config.providers[active.provider]?.type,
    );
    if (w) console.error(`[cleetus] WARNING: ${w}`);
    for (const warning of await providerReadinessWarnings(
      providers,
      active.provider,
      active.model,
    )) {
      console.error(`[cleetus] WARNING: ${warning}`);
    }
  }
  if (config.orchestration.enabled) {
    const roles = [
      {
        label: "orchestrator",
        provider: config.orchestration.orchestratorProvider,
        model: config.orchestration.orchestratorModel,
      },
      {
        label: "worker",
        provider: config.orchestration.workerProvider,
        model: config.orchestration.workerModel,
      },
    ];
    for (const r of roles) {
      // "" → the active provider/model at the call site; only validate what was pinned.
      if (r.provider && !providers.names().includes(r.provider)) {
        console.error(
          `[cleetus] WARNING: orchestration ${r.label}_provider "${r.provider}" is not a configured provider; calls may fail.`,
        );
        continue; // can't check the model against an unknown provider
      }
      // Check the model against its resolved provider (pinned or active), not just any provider.
      const provider = r.provider || active.provider;
      const pc = catalog.find((c) => c.provider === provider);
      if (r.model && pc && !pc.models.includes(r.model)) {
        console.error(
          `[cleetus] WARNING: orchestration ${r.label} model "${r.model}" not found on provider "${provider}"; calls may fail.`,
        );
      }
    }
  }
  let notifyActiveChanged: ((next: { provider: string; model: string }) => void) | null = null;
  const updateActive = (p: string, m: string) => {
    active.provider = p;
    active.model = m;
    void modelContext.prime([{ provider: p, model: m }]).then(async () => {
      const contextWarning = lowContextWarning(
        m,
        modelContext.get(p, m),
        undefined,
        config.providers[p]?.type,
      );
      const readiness = await providerReadinessWarnings(providers, p, m);
      for (const text of [contextWarning, ...readiness]) {
        if (!text) continue;
        log.append({ sessionId: session.id, type: "notice", payload: { text, level: "warn" } });
      }
    });
    // Keep the session record in sync so the listing reflects the running model,
    // not just the startup default.
    sessions.updateModel(session.id, p, m);
    notifyActiveChanged?.({ provider: p, model: m });
  };

  let notifyModeChanged: ((mode: PermissionMode) => void) | null = null;
  let openModePicker: ((initial?: PermissionMode) => void) | null = null;
  const setMode = (mode: PermissionMode) => {
    // Remember where we came from so approving a plan can restore it. Only capture on a genuine
    // transition INTO plan mode — re-entering plan while already in plan must NOT overwrite
    // priorMode with "plan", or approving a plan becomes a no-op and the session sticks in plan
    // mode (every edit + orchestration worker blocked).
    permState.priorMode = nextPriorMode(permState.mode, mode, permState.priorMode);
    permState.mode = mode;
    notifyModeChanged?.(mode);
  };

  const routeState = { mode: startRouteMode };
  let notifyRouteChanged: ((mode: RouteMode) => void) | null = null;
  const setRouteMode = (mode: RouteMode) => {
    routeState.mode = mode;
    notifyRouteChanged?.(mode);
  };

  // Track the tier and router reason of the most recent model call for the `/route` status line.
  let lastTier: "small" | "large" | null = null;
  let lastReason: string | null = null;
  log.subscribe(session.id, (e) => {
    if (e.type === "model_call_start") {
      const payload = e.payload as { tier?: "small" | "large" | null; reason?: string };
      if (payload.tier !== undefined) lastTier = payload.tier;
      if (payload.reason !== undefined) lastReason = payload.reason;
    }
  });

  const interactiveOpts: AgentRuntimeOptions = {
    providers,
    tools,
    dispatcher,
    log,
    router: createRouter({
      getMode: () => routeState.mode,
      getActive: () => ({ provider: active.provider, model: active.model }),
      tiers: routing.tiers,
      smart: routing.smart,
    }),
    systemPrompt,
    projectDir,
    resolvePermission: async ({ tool, args, argsSummary }) => {
      const escapes = await writeEscapesProject(tool, args, projectDir);
      const targetPath = await resolveToolTargetPath(tool, args, projectDir);
      const baseline = evaluatePermission(rules, tool, argsSummary, targetPath ?? undefined);
      // Explicit deny always wins
      if (baseline === "deny") return "deny";
      // WorkflowService performs the consolidated exact-revision authority check.
      if (tool === "run_workflow") return "allow";
      // Out-of-project READ: the builtin `allow` default does not apply outside the tree.
      // An explicit rule (whole-tool allow, argsPattern, or a pathPrefix directory grant)
      // decides; otherwise prompt, offering the [d]ir broaden → persistable pathPrefix rule.
      // Secret paths were already refused inside the tool (read-guard) regardless of outcome.
      // In-project reads never reach this block by design: resolveReadTarget().escapes is only
      // true once the resolved target leaves projectDir, so pathPrefix read rules (and this
      // whole prompt path) only ever govern escaping reads.
      const read = await resolveReadTarget(tool, args, projectDir);
      if (read?.escapes) {
        // A secret-path read is refused inside the tool regardless of any grant — including a
        // broad pathPrefix allow rule — so decide this before consulting rules at all; mirrors
        // the one-shot resolver's unconditional secret-path deny above.
        if (isSecretPath(read.target, homedir())) return "deny";
        const ruled = evaluateRules(rules, tool, argsSummary, read.target);
        if (ruled === "deny") return "deny";
        if (ruled !== "allow") {
          if (permState.mode === "fuckit") return "allow";
          if (!resolverFn) return "deny";
          const warnedSummary = `⚠ reads OUTSIDE project dir: ${argsSummary}`;
          return new Promise<Decision>((respond) => {
            // readEscape: true routes [a]/[g] through PermissionPrompt's directory-scoped
            // quick-grant (readEscapeQuickGrant) instead of the whole-tool allow_project/
            // allow_global path — a bare `escapes`-less request here would otherwise fall
            // into handlePermission's `!p.escapes` branch and persist "allow read_file
            // everywhere". `escapes` itself is deliberately left unset: that flag's
            // allow_global path grants the out-of-project WRITE hatch, which is unrelated.
            resolverFn!(
              { tool, argsSummary: warnedSummary, targetPath: read.target, readEscape: true },
              respond,
            );
          });
        }
      }
      // Out-of-tree write: force a prompt even under fuckit
      if (escapes) {
        // Session already granted out-of-project writes (allow-global earlier, or --fuckit):
        // permit without re-prompting. The tool's boundary guard reads the same grant.
        if (permState.allowOutsideProject || permState.mode === "fuckit") return "allow";
        if (!resolverFn) return "deny";
        const warnedSummary = `⚠ OUTSIDE project dir: ${argsSummary}`;
        return new Promise<Decision>((resolve) => {
          // targetPath intentionally omitted: the directory-broaden option is suppressed on
          // the out-of-tree prompt (pathPrefix WRITE rules only govern in-project paths;
          // out-of-project READ prompts handle their own dir grants, above).
          resolverFn!(
            { tool, argsSummary: warnedSummary, escapes: true },
            (decision, grantOutside) => {
              if (grantOutside) permState.allowOutsideProject = true;
              resolve(decision);
            },
          );
        });
      }
      // Permissions disabled (fuckit or config): allow non-escaping writes
      if (permState.mode === "fuckit") return "allow";
      // Explicit allow
      if (baseline === "allow") return "allow";
      // ask → prompt via TUI
      if (!resolverFn) return "deny";
      // Silently-degraded sandbox: the first bash approval doubles as the one-time consent —
      // the warning names what is unprotected, and approving persists the ack (never re-shown).
      const needsConsent = sandboxDegraded && tool === "bash" && !degradedConsent.acked;
      const promptSummary = needsConsent
        ? `⚠ UNSANDBOXED HOST — no sandbox available; .git/.cleetus/secret dirs are NOT protected. Approving acknowledges this permanently.\n${argsSummary}`
        : argsSummary;
      return new Promise<Decision>((respond) => {
        resolverFn!(
          { tool, argsSummary: promptSummary, targetPath: targetPath ?? undefined },
          (decision, _grantOutside) => {
            if (needsConsent && decision === "allow") {
              degradedConsent.acked = true;
              // Best-effort: consent persistence failing (EACCES/EROFS/ENOSPC — plausible in
              // exactly the degraded environments this targets) must not crash the process; the
              // in-memory ack still holds for this process.
              void writeAppState(GLOBAL_DIR, { sandboxDegradedAck: true }).catch(() => {});
            }
            respond(decision);
          },
        );
      });
    },
    maxToolLoops: () => loopCapState.value,
    workerTurnTokens: config.orchestration.workerTurnTokens,
    workerProgressExtensionTokens: config.orchestration.workerProgressExtensionTokens,
    workerMaxTokenMultiplier: config.orchestration.workerMaxTokenMultiplier,
    workerNoProgressTokens: config.orchestration.workerNoProgressTokens,
    workerTurnMs: config.orchestration.workerTurnMs,
    workerThrashRepeats: () => config.orchestration.workerThrashRepeats,
    protectExistingFiles: () => config.orchestration.protectExistingFiles,
    guardPendingScope: () => config.orchestration.guardPendingScope,
    context: () => config.context,
    malformedPath: () => config.malformedPath,
    loopGuard: () => config.loopGuard,
    streamWatchdog: () => config.streamWatchdog,
    planModeGuard: () => config.planMode,
    modelContextLength: (m?: string, p?: string) =>
      modelContext.get(p ?? active.provider, m ?? active.model),
    modelContextInfo: (m?: string, p?: string) =>
      modelContext.getInfo(p ?? active.provider, m ?? active.model),
    effort: () => effortState.level,
    planMode: () => permState.mode === "plan",
    allowOutsideProject: () => permState.mode === "fuckit" || permState.allowOutsideProject,
    diagnostics,
    formatter,
    hooks: hookEngine,
    checkpoints: checkpointStore,
    historyStore,
    modelFamily: config.modelFamily,
    structuredOutput: () => config.structuredOutput ?? "auto",
    capability: () => config.capability,
    modelProfile: (model, provider) => config.modelProfiles?.[provider]?.[model],
    smallSystemPrompt,
    voiceReminder: () => voiceTurnReminder(personalityState.id),
    voiceCorrection: (text) =>
      gatedVoiceCorrection(config.personalityCorrection, personalityState.id, text),
    webToolsEnabled: () => config.webTools.enabled,
    completionAudit: true,
    suggestLearnedPlaybook: true,
    triggeredSkillReminders: (userInput) =>
      config.skills.enabled && config.skills.autoInvoke
        ? triggeredSkills(skillRegistry.list(), userInput).map((skill) => ({
            name: skill.name,
            reminder: renderSkillReminder(skill),
          }))
        : [],
  };
  const runtime = new AgentRuntime(interactiveOpts);
  if (config.subagents.enabled) {
    tools.register(new SubagentTool(buildSubagentSpawner(interactiveOpts)));
  }

  // Orchestrated plan execution (gated). Orchestrator + worker MIRROR the live session model
  // (`active`) — the same model the main agent uses — unless config pins orchestrator_model /
  // worker_model. Resolved LIVE (thunks / a live router), NOT snapshot: `active` may still hold the
  // startup default here and only become the user's pick once the startup model picker fires, so a
  // snapshot would wrongly lock orchestration to the default model. Worker events route to the MAIN
  // session, actor-stamped.
  const orchestratorModel = () => config.orchestration.orchestratorModel || active.model;
  const workerModelOf = () => config.orchestration.workerModel || active.model;
  // Provider overrides mirror the model overrides: a pinned provider wins, else the live active
  // provider. The provider map (registry) holds every configured provider, so a worker/orchestrator
  // can run on a different provider than the main agent.
  const orchestratorProviderOf = () => config.orchestration.orchestratorProvider || active.provider;
  const workerProviderOf = () => config.orchestration.workerProvider || active.provider;
  const orchLog = stampActor(log, { role: "orchestrator" });
  const workerRouter: Router = {
    select: () => ({
      choice: { provider: workerProviderOf(), model: workerModelOf() },
      tier: null,
      reason: "orchestration-worker",
    }),
    finishPass: () => null,
  };
  const recoveryRouter: Router = {
    select: () => ({
      choice: { provider: orchestratorProviderOf(), model: orchestratorModel() },
      tier: null,
      reason: "orchestration-recovery",
    }),
    finishPass: () => null,
  };
  // Hoisted so the orchestrator deps (below) and the worker spawner share one binding — the
  // spawner needs `workerSkillSeed` (execute-scoped task-text resolver) to close the base-trigger
  // leak (Task 6): a decompose-only skill (e.g. TDD) must never reach a worker via task text.
  const orchSkillDeps = orchestrationSkillDeps(
    () => skillRegistry.list(),
    config.skills.enabled && config.skills.autoInvoke,
  );
  const workerSpawner = buildOrchestrationWorkerSpawner(
    { ...interactiveOpts, router: workerRouter },
    {
      sessionId: session.id,
      voiceOverlay: () => overlayFor(personalityState.id),
      workerSkillSeed: orchSkillDeps.workerSkillSeed,
    },
  );
  const recoverySpawner = buildOrchestrationWorkerSpawner(
    { ...interactiveOpts, router: recoveryRouter },
    {
      sessionId: session.id,
      voiceOverlay: () => overlayFor(personalityState.id),
      workerSkillSeed: orchSkillDeps.workerSkillSeed,
    },
  );
  const noResponseFormat = new NoResponseFormatMemo();
  const callModel = async (
    model: string,
    system: string,
    user: string,
    signal: AbortSignal,
    responseFormat?: { name: string; schema: object; kind: "tool-call" | "json" },
  ): Promise<string> => {
    const callId = ulid();
    orchLog.append({
      sessionId: session.id,
      type: "model_call_start",
      payload: { callId, model, reason: "orchestrator" },
    });
    // Resolves the provider NAME only — safe to hoist outside the try; `providers.get` itself
    // stays inside (an unknown pinned provider yields empty output, handled by the orchestrator).
    const providerName = orchestratorProviderOf();
    const constrained =
      responseFormat !== undefined &&
      (config.structuredOutput ?? "auto") === "auto" &&
      !noResponseFormat.has(providerName);
    let text = "";
    try {
      const provider = providers.get(providerName);
      const req = {
        model,
        messages: [
          { role: "system" as const, content: system },
          { role: "user" as const, content: user },
        ],
        signal,
        modelFamily: config.modelFamily,
      };
      try {
        for await (const ev of provider.chat(constrained ? { ...req, responseFormat } : req)) {
          if (ev.type === "text-delta") text += ev.text;
        }
      } catch (err) {
        // Attempt-and-memoize (WS4): a server that rejects response_format gets one
        // unconstrained retry and is never sent the constraint again this session.
        if (constrained && isNoResponseFormatError(err) && !signal.aborted) {
          noResponseFormat.add(providerName);
          text = "";
          for await (const ev of provider.chat(req)) {
            if (ev.type === "text-delta") text += ev.text;
          }
        } else {
          throw err;
        }
      }
    } catch {
      // Swallows errors AND abort: return partial text; orchestrator handles empty output.
    }
    orchLog.append({
      sessionId: session.id,
      type: "model_call_end",
      payload: { callId, reason: "orchestrator" },
    });
    return text;
  };
  const orchestrator = new Orchestrator({
    config: config.orchestration,
    orchestratorModel,
    callModel,
    spawnWorker: workerSpawner,
    spawnRecoveryWorker: recoverySpawner,
    userInstructions: () => instructions,
    ...orchSkillDeps,
    rosterLine: () => formatOrchestrationRoles({ active, orchestration: config.orchestration }),
    // Mirror the LIVE personality so the closing summary speaks in the user's selected voice
    // (a /personality switch mid-session is honoured); neutral → "" → no change.
    voiceOverlay: () => overlayFor(personalityState.id),
    verifyBuild: makeVerifyBuild({ projectDir, sandbox, config: config.buildGate }),
    verifyQuality: makeVerifyQuality({ projectDir, sandbox, config: config.buildGate }),
    inspectProject: () => inspectProject(projectDir),
    projectDir,
    listDir: async (path: string) => {
      try {
        return await readdir(path);
      } catch {
        return [];
      }
    },
    log: orchLog,
    sessionId: session.id,
    recordSummary: (text) => runtime.recordOrchestrationSummary(session.id, text),
  });
  // Derive the orchestrator's inputs from history: last user message = request, last non-empty
  // assistant message = the approved prose plan. Plan approval only reachable from plan mode (so a
  // plan reply normally exists); degenerate cases (no assistant turn, or a "(cancelled)" last
  // reply) yield an empty/odd prosePlan, which the structuring call handles via reprompt+fallback.
  const getPlanContext = (): { request: string; prosePlan: string } => {
    const msgs = runtime.getMessages(session.id);
    let request = "";
    let prosePlan = "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (!prosePlan && m.role === "assistant" && m.content.trim())
        prosePlan = stripSystemReminders(m.content);
      if (!request && m.role === "user") request = stripSystemReminders(m.content);
      if (request && prosePlan) break;
    }
    return { request, prosePlan };
  };

  // Seed the resumed/forked conversation now that the runtime exists, before the TUI mounts.
  if (snapshotToLoad) {
    runtime.loadSession(session.id, snapshotToLoad.messages, snapshotToLoad.todos);
  }

  // Resumable picker rows: prior sessions that have a saved conversation snapshot,
  // most-recent first (sessions.list() is already ordered that way).
  const resumableRows = (): SessionRow[] => {
    const previews = sessions
      .list()
      .filter((s) => historyStore.exists(s.id))
      .map((s) => sessionPreview(s, log.query(s.id)));
    return sessionRows(previews, Date.now());
  };

  // Fork the current session: snapshot it, copy its history into a fresh session, return its id.
  const forkSession = (): { id: string } | null => {
    runtime.snapshotSession(session.id);
    if (!historyStore.load(session.id)) return null;
    const forked = sessions.create({
      provider: session.provider,
      model: session.model,
      title: `fork of ${session.id.slice(0, 8)}`,
    });
    historyStore.copy(session.id, forked.id);
    return { id: forked.id };
  };

  // Checkpoint list projection (shared by the /rewind command and the picker props),
  // and the rewind action: restore files, truncate the conversation, log the marker.
  const listCheckpoints = () =>
    checkpointStore
      ?.list(session.id)
      .map(({ turnNumber, userInput, ts }) => ({ turnNumber, userInput, ts })) ?? [];
  const rewindTo = async (turnNumber: number) => {
    if (!checkpointStore) return;
    const outcome = await checkpointStore.rewindTo(session.id, turnNumber);
    if (!outcome) return;
    runtime.truncateHistory(session.id, outcome.historyLength);
    const { cleared } = runtime.restoreTodos(session.id, outcome.todos);
    // Persist the reverted state so a later resume/fork reflects the rewind.
    runtime.snapshotSession(session.id);
    log.append({
      sessionId: session.id,
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
  };

  const learnPlaybook = new LearnPlaybookService({
    events: log,
    eventSink: log,
    getSessionId: () => session.id,
    providers,
    getActive: () => ({ provider: active.provider, model: active.model }),
    skills: skillRegistry,
    projectDir,
    globalDir: GLOBAL_DIR,
    skillsEnabled: config.skills.enabled,
    autoInvoke: config.skills.autoInvoke,
    structuredOutput: (config.structuredOutput ?? "auto") === "auto",
    modelFamily: config.modelFamily,
  });
  const workflowCreatorSkill = skillRegistry.get("workflow-creator");
  const projectWorkflowRoot = join(projectDir, ".cleetus", "workflows");
  const globalWorkflowRoot = join(GLOBAL_DIR, "workflows");
  const manualWorkflowLocation = (
    name: string,
    scope?: "project" | "global",
  ): { scope: "project" | "global"; root: string } => {
    if (scope) {
      return {
        scope,
        root: scope === "global" ? globalWorkflowRoot : projectWorkflowRoot,
      };
    }
    if (existsSync(join(projectWorkflowRoot, ".manual-drafts", name, "draft.json"))) {
      return { scope: "project", root: projectWorkflowRoot };
    }
    if (existsSync(join(globalWorkflowRoot, ".manual-drafts", name, "draft.json"))) {
      return { scope: "global", root: globalWorkflowRoot };
    }
    const active = workflowRuntime.service.show(name);
    return { scope: active.source, root: dirname(active.dir) };
  };
  const manualWorkflowAuthoring = {
    open(name: string, scope?: "project" | "global") {
      const selectedScope = scope ?? workflowRuntime.service.show(name).source;
      const lexicalRoot = selectedScope === "global" ? globalWorkflowRoot : projectWorkflowRoot;
      const root = confinedEditorRoot({
        boundary: selectedScope === "global" ? GLOBAL_DIR : projectDir,
        root: lexicalRoot,
        label: `${selectedScope} workflow root`,
      });
      const active = scope
        ? loadWorkflowPackage(
            confinedEditorTarget({
              root,
              target: join(root, name),
              label: `${selectedScope} workflow package`,
            }),
            scope,
          )
        : workflowRuntime.service.show(name);
      confinedEditorTarget({
        root,
        target: active.dir,
        label: `${selectedScope} workflow package`,
      });
      const existing = existsSync(join(root, ".manual-drafts", name, "draft.json"));
      const draft = existing
        ? loadManualWorkflowDraft({ root, name, scope: active.source })
        : beginManualWorkflowRevision({ active, root });
      return {
        packageDir: draft.packageDir,
        created: !existing,
        scope: active.source,
      };
    },
    async review(name: string, scope?: "project" | "global") {
      const location = manualWorkflowLocation(name, scope);
      return formatManualWorkflowReview(
        await reviewManualWorkflowDraft({
          ...location,
          name,
          steps: (pkg) => workflowRuntime.stepRegistry(pkg),
        }),
      );
    },
    async publish(name: string, scope?: "project" | "global") {
      const location = manualWorkflowLocation(name, scope);
      const result = await publishManualWorkflowDraft({
        ...location,
        name,
        steps: (pkg) => workflowRuntime.stepRegistry(pkg),
        registry: workflowRuntime.registry,
      });
      return [
        `Published ${location.scope} workflow '${name}' revision ${result.revision}.`,
        `Active: ${result.activeDir}`,
        result.backupDir ? `Archived previous revision: ${result.backupDir}` : undefined,
        "The workflow was not run.",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    },
    discard(name: string, scope?: "project" | "global") {
      const location = manualWorkflowLocation(name, scope);
      discardManualWorkflowDraft({ ...location, name });
      return `Discarded the ${location.scope} manual draft for '${name}'. The active workflow was not changed.`;
    },
  };
  const workflowController = new WorkflowCommandController(
    workflowRuntime.service,
    workflowCreatorSkill
      ? {
          creator: new WorkflowCreatorController(
            new WorkflowDraftStore(join(projectDir, ".cleetus", "workflows")),
            new StructuredWorkflowCreatorModel(
              new WorkflowModelCallService((name) => providers.get(name)),
              () => ({ provider: active.provider, model: active.model }),
            ),
            composeSkillBody(workflowCreatorSkill),
            (packageDir, scope) =>
              workflowRuntime.stepRegistry(loadWorkflowPackage(packageDir, scope)),
          ),
          activate(draft, replace) {
            const activeRoot =
              draft.scope === "global"
                ? join(GLOBAL_DIR, "workflows")
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
              type: "workflow_status",
              payload: {
                ...payload,
                activity: "creator",
                failed: type === "error",
              },
            });
          },
        }
      : undefined,
    manualWorkflowAuthoring,
  );

  const projectPermsPath = join(projectDir, ".cleetus", "permissions.yaml");
  const projectConfigPath = join(projectDir, ".cleetus", "config.yaml");
  const projectInstructionsPath = join(projectHome ?? projectDir, ".cleetus", "instructions.md");
  const ensureEditorFile = (path: string, initial: string): string => {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, initial, { encoding: "utf8", flag: "wx" });
    }
    return path;
  };
  const prepareScopedEditorFile = (input: {
    root: string;
    path: string;
    initial: string;
    label: string;
  }): string => {
    confineEditorCreation({
      root: input.root,
      target: input.path,
      label: input.label,
    });
    ensureEditorFile(input.path, input.initial);
    return confinedEditorTarget({
      root: input.root,
      target: input.path,
      label: input.label,
    });
  };
  const prepareDiscoveredInstruction = (path: string): string => {
    const parent = dirname(path);
    const boundary = basename(parent) === ".cleetus" ? dirname(parent) : parent;
    const root = confinedEditorRoot({
      boundary,
      root: parent,
      label: "instruction source root",
    });
    return confinedEditorTarget({ root, target: path, label: "instruction source" });
  };
  const prepareSkillEditorTarget = (skill: Skill): string => {
    const target = skill.baseDir ?? skill.filePath!;
    const skillsRoot = skill.baseDir ? dirname(skill.baseDir) : dirname(skill.filePath!);
    if (basename(skillsRoot) !== "skills" || basename(dirname(skillsRoot)) !== ".cleetus") {
      throw new Error(`skill '${skill.name}' is not inside a recognized .cleetus/skills root`);
    }
    const root = confinedEditorRoot({
      boundary: dirname(dirname(skillsRoot)),
      root: skillsRoot,
      label: `skill '${skill.name}' root`,
    });
    return confinedEditorTree({ root, target, label: `skill '${skill.name}'` });
  };
  let unmountApp: (() => void) | null = null;
  const commands = buildCommandRegistry({
    providers,
    getActive: () => ({ provider: active.provider, model: active.model }),
    setActive: updateActive,
    getPermissions: () => rules,
    getInstructions: () => instructions,
    configEditor: {
      prepare(scope) {
        return prepareScopedEditorFile({
          root: scope === "global" ? GLOBAL_DIR : projectDir,
          path: scope === "global" ? GLOBAL_CONFIG : projectConfigPath,
          initial: "# Cleetus configuration\n",
          label: `${scope} configuration`,
        });
      },
      async reload() {
        await loadConfig({ globalPath: GLOBAL_CONFIG, projectDir });
        return "Configuration is valid. Restart Cleetus to apply all configuration changes.";
      },
    },
    permissionsEditor: {
      prepare(scope) {
        return prepareScopedEditorFile({
          root: scope === "global" ? GLOBAL_DIR : projectDir,
          path: scope === "global" ? GLOBAL_PERMS : projectPermsPath,
          initial: "rules: []\n",
          label: `${scope} permissions`,
        });
      },
      async reload() {
        const reloaded = await loadPermissions({
          globalPath: GLOBAL_PERMS,
          projectDir,
        });
        rules.project.splice(0, rules.project.length, ...reloaded.project);
        rules.global.splice(0, rules.global.length, ...reloaded.global);
        return `Reloaded permissions: ${rules.project.length} project, ${rules.global.length} global rule(s).`;
      },
    },
    instructionsEditor: {
      async prepare(scope) {
        if (scope === "global") {
          return prepareScopedEditorFile({
            root: GLOBAL_DIR,
            path: GLOBAL_INSTR,
            initial: "# Global Cleetus instructions\n",
            label: "global instructions",
          });
        }
        if ((scope === "project" || scope === "cleetus") && !inheritProjectInstructions) {
          throw new Error(
            "project instructions are disabled for this session; edit global instructions or restart without --no-project-instructions",
          );
        }
        if (scope === "cleetus") {
          return prepareScopedEditorFile({
            root: projectDir,
            path: join(projectDir, "CLEETUS.md"),
            initial: "# Project instructions\n",
            label: "project CLEETUS.md",
          });
        }
        if (scope === "project") {
          return prepareScopedEditorFile({
            root: projectDir,
            path: projectInstructionsPath,
            initial: "# Project Cleetus instructions\n",
            label: "project instructions",
          });
        }
        const sources = await instructionSourcePaths(instructionLoadOptions);
        if (sources.length === 1) {
          return prepareDiscoveredInstruction(sources[0]!);
        }
        if (sources.length === 0) {
          return prepareScopedEditorFile({
            root: projectDir,
            path: projectInstructionsPath,
            initial: "# Project Cleetus instructions\n",
            label: "project instructions",
          });
        }
        throw new Error(
          `multiple instruction sources are active:\n${sources.map((path) => `- ${path}`).join("\n")}\nUse /instructions edit project, /instructions edit global, or /instructions edit cleetus.`,
        );
      },
      async reload() {
        instructions = await loadInstructions(instructionLoadOptions);
        return `Reloaded instructions from ${(await instructionSourcePaths(instructionLoadOptions)).length} source(s).`;
      },
    },
    projectPermissionsPath: projectPermsPath,
    globalPermissionsPath: GLOBAL_PERMS,
    onClear: () => {
      runtime.resetHistory(session.id);
    },
    onExit: () => {
      unmountApp ? unmountApp() : process.exit(0);
    },
    onShowModels: () => {
      openModelPicker?.();
    },
    getMode: () => permState.mode,
    setMode,
    onShowMode: (initial) => {
      openModePicker?.(initial);
    },
    getRouteMode: () => routeState.mode,
    setRouteMode,
    onShowRoute: () => {
      openRoutePicker?.();
    },
    getPersona: () => personaState.id,
    setPersona,
    onShowPersona: () => {
      openPersonaPicker?.();
    },
    systemPromptOverridden: personaOverride != null,
    getEffort: () => effortState.level,
    setEffort,
    onShowEffort: () => {
      openEffortPicker?.();
    },
    // Omit the deps entirely when checkpoints are disabled, so `/rewind` is hidden
    // from /help + autocomplete rather than appearing as a non-functional command.
    getCheckpoints: checkpointStore ? listCheckpoints : undefined,
    rewindToCheckpoint: checkpointStore ? rewindTo : undefined,
    onShowRewind: () => {
      openRewindPicker?.();
    },
    forkSession,
    stageImagePaths: async (paths) => {
      await stageImagePathsFn?.(paths);
    },
    clearStagedImages: () => clearStagedImagesFn?.(),
    stageClipboardImage: async () => {
      await stageClipboardImageFn?.();
    },
    getSessionId: () => session.id,
    getSessions: () =>
      sessions.list().map((candidate) => sessionPreview(candidate, log.query(candidate.id))),
    compactSession: (instruction) => runtime.compactNow(session.id, instruction),
    getPersonality: () => personalityState.id,
    setPersonality,
    onShowPersonality: () => {
      openPersonalityPicker?.();
    },
    getOrchestrationEnabled,
    setOrchestrationEnabled,
    getMaxLoops: () => loopCapState.value,
    setMaxLoops: (n: number) => {
      loopCapState.value = n === 0 ? Number.POSITIVE_INFINITY : n;
    },
    getTiers: () => routing.tiers,
    getLastTier: () => lastTier,
    getLastReason: () => lastReason,
    getSkills: () => skillRegistry,
    prepareSkillEditorTarget,
    reloadSkill: async (name, expectedFilePath) => {
      const refreshed = await bootstrapSkills({
        startDir: projectDir,
        globalDir: GLOBAL_DIR,
        projectHome,
        enabled: config.skills.enabled,
        suppressHint: true,
      });
      const skill = refreshed.registry.get(name);
      const matchesEditedSource =
        skill?.source !== "built-in" && skill?.filePath === expectedFilePath;
      if (matchesEditedSource) skillRegistry.upsert(skill);
      return {
        skill: matchesEditedSource ? skill : undefined,
        warnings: refreshed.warnings,
      };
    },
    learnPlaybook,
    workflowController,
    collectWorkflowInputs: (request) => collectWorkflowInputs(request),
    getMcpStatus: () => mcp.status(),
    memory: memoryStores,
    runIndex: async (args, print) => {
      if (!vectorService.enabled) {
        print("embeddings not configured — add an `embeddings` block to config.yaml");
        return;
      }
      try {
        const summary = await indexer.run({
          rebuild: args === "rebuild",
          onProgress: (p) => {
            if (p.phase === "scan") print(`scanning… ${p.total} files tracked`);
          },
        });
        if (summary.rebuilt && args !== "rebuild") {
          print("embedding model changed — rebuilt from scratch");
        }
        print(
          `indexed ${summary.indexedFiles} files (${summary.indexedChunks} chunks) · ` +
            `${summary.skipped} unchanged · ${summary.removed} removed · ` +
            `${(summary.elapsedMs / 1000).toFixed(1)}s`,
        );
      } catch (e) {
        print(`index failed: ${(e as Error).message}`);
      }
    },
    runInsights: async (args, print) => {
      const { analyze, collectTrajectories } = await import("../insights/report");
      const { formatReport } = await import("../insights/format");
      const { selectSamples, explainReport } = await import("../insights/explain");
      const tokens = args.split(/\s+/).filter(Boolean);
      const wantExplain = tokens.includes("explain");
      const sinceIdx = tokens.indexOf("since");
      let since: number | undefined;
      if (sinceIdx >= 0) {
        const sinceVal = tokens[sinceIdx + 1];
        if (!sinceVal) {
          print("'since' requires a value (e.g. since 7d, since 24h, since 30m)");
          return;
        }
        const m = /^(\d+)([dhm])$/.exec(sinceVal);
        if (m) {
          const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as "d" | "h" | "m"];
          since = Date.now() - Number(m[1]) * unit;
        } else {
          print(`invalid 'since' value '${sinceVal}' (use e.g. 7d, 24h, 30m)`);
          return;
        }
      }
      const filter = { since };
      const report = analyze(log, filter);
      print(formatReport(report));
      if (wantExplain) {
        try {
          const provider = providers.get(active.provider);
          const samples = selectSamples(report, collectTrajectories(log, filter));
          const prose = await explainReport(report, samples, provider, active.model);
          if (prose.trim()) print(`\n## Suggestions\n${prose}`);
        } catch (e) {
          print(`explain skipped: ${(e as Error).message}`);
        }
      }
    },
    runReview: async (args, print) => {
      const controller = new AbortController();
      const argv = args.split(/\s+/).filter(Boolean);
      const gitCtx = { projectDir, abortSignal: controller.signal };
      const spawner = buildSubagentSpawner(interactiveOpts);
      const msgs = runtime.getMessages(session.id);
      const intent = lastUserRequest(
        msgs.map((m) => ({ role: m.role, content: stripSystemReminders(m.content) })),
      );
      await runReview(
        argv,
        {
          git: (a) =>
            runGit(sandbox, a, gitCtx).then((r) => ({
              exitCode: r.exitCode,
              stdout: r.stdout,
              stderr: r.stderr,
            })),
          spawn: (prompt, signal) =>
            spawner({ type: "review", prompt, signal }).then((r) => r.assistantText),
          intent,
          signal: controller.signal,
          emitFindings: (md) => runtime.seedReviewFindings(session.id, md),
        },
        print,
      );
    },
    buildSpecSeed: (idea) => {
      const skill = skillRegistry.get("spec-creator");
      if (!skill) return undefined;
      return buildSpecTurn({
        playbookBody: composeSkillBody(skill),
        specsDir: config.specs.dir,
        datePrefix: specDatePrefix(new Date()),
        idea,
        orchestrationAvailable: getOrchestrationEnabled(),
      });
    },
  });

  const approvePlan = () => {
    setMode(permState.priorMode);
  };

  let startupCancelled = false;
  const onStartupCancel = () => {
    startupCancelled = true;
    unmountApp?.();
  };

  const theme = resolveTheme(config.ui.theme, config.ui.colors);
  // Coalesce Ink's per-frame writes into one synchronized update. Without this the erase and the
  // redraw of a frame can be painted separately — barely visible on a native pty, a constant flash
  // through WSL2's conpty bridge. See ui/tui/frame-writer.
  // Opt-in render diagnostics (CLEETUS_RENDER_DEBUG) for the intermittent duplicate-final-answer
  // bug: record each time Ink takes its full-screen-clear branch (the path that can duplicate a
  // tall row into scrollback), alongside the terminal height at that moment. No-op when disabled.
  const renderDebug = createRenderDebugSink(
    join(projectDir, ".cleetus", "render-debug.jsonl"),
    renderDebugEnabled(process.env),
  );
  let fullClearSeq = 0;
  const frameWriter = createFrameWriter(process.stdout, {
    sync: syncOutputEnabled(process.env, process.stdout),
    onFullClear: renderDebugEnabled(process.env)
      ? ({ bytes }) =>
          renderDebug.log({
            kind: "full_clear",
            ts: Date.now(),
            rows: process.stdout.rows ?? null,
            bytes,
            seq: fullClearSeq++,
          })
      : undefined,
  });
  // A crash or signal must not leave the last frame sitting in the buffer.
  process.once("exit", frameWriter.flush);
  const { waitUntilExit, unmount } = render(
    React.createElement(
      ThemeProvider,
      { value: theme },
      React.createElement(App, {
        sessionId: session.id,
        runtime,
        log,
        commands,
        launchEditor: async (request, cwd, authorizeOutsideProject) => {
          return await launchEditor({ ...request, cwd, authorizeOutsideProject });
        },
        workflowController,
        projectPermissionsPath: projectPermsPath,
        globalPermissionsPath: GLOBAL_PERMS,
        cwd: projectDir,
        specsDir: config.specs.dir,
        vision: config.vision,
        resize: config.resize,
        stageImagePathsRegister: (fn) => {
          stageImagePathsFn = fn;
        },
        clearStagedImagesRegister: (fn) => {
          clearStagedImagesFn = fn;
        },
        stageClipboardImageRegister: (fn) => {
          stageClipboardImageFn = fn;
        },
        providers,
        catalog,
        skills: skillRegistry,
        getActive: () => ({ provider: active.provider, model: active.model }),
        onSelectModel: updateActive,
        onSelectMode: setMode,
        resolverRegister: (fn) => {
          resolverFn = fn;
        },
        workflowAuthorizationRegister: (fn) => {
          requestWorkflowAuthorization = fn;
        },
        workflowInputRegister: (fn) => {
          collectWorkflowInputs = fn;
        },
        modelPickerRegister: (open) => {
          openModelPicker = open;
        },
        modePickerRegister: (open) => {
          openModePicker = open;
        },
        activeDisplayRegister: (set) => {
          notifyActiveChanged = set;
        },
        modeDisplayRegister: (set) => {
          notifyModeChanged = set;
        },
        routeMode: routeState.mode,
        routeDisplayRegister: (set) => {
          notifyRouteChanged = set;
        },
        onSelectRoute: setRouteMode,
        routePickerRegister: (open) => {
          openRoutePicker = open;
        },
        persona: personaState.id,
        personaDisplayRegister: (set) => {
          notifyPersonaChanged = set;
        },
        onSelectPersona: setPersona,
        personaPickerRegister: (open) => {
          openPersonaPicker = open;
        },
        effort: effortState.level,
        effortDisplayRegister: (set) => {
          notifyEffortChanged = set;
        },
        onSelectEffort: setEffort,
        effortPickerRegister: (open) => {
          openEffortPicker = open;
        },
        getCheckpoints: listCheckpoints,
        onSelectRewind: rewindTo,
        rewindPickerRegister: (open: () => void) => {
          openRewindPicker = open;
        },
        getResumableSessions: resumableRows,
        openSessionPickerOnStart,
        onSelectSession: (id: string) => {
          // Startup picker selected a session: load its snapshot + re-point bin-side
          // state so /fork, /rewind, and the tier subscription target the resumed session.
          const snap = historyStore.load(id);
          const resumed = sessions.get(id);
          if (resumed) session = resumed;
          if (snap) runtime.loadSession(id, snap.messages, snap.todos);
        },
        personality: personalityState.id,
        personalityDisplayRegister: (set) => {
          notifyPersonalityChanged = set;
        },
        onSelectPersonality: setPersonality,
        personalityPickerRegister: (open) => {
          openPersonalityPicker = open;
        },
        tiersConfigured: Boolean(routing.tiers),
        planMode: permState.mode === "plan",
        onApprovePlan: approvePlan,
        planOrGoEnabled: config.planOrGo.enabled,
        streamingEnabled: config.streaming.enabled,
        reasoningEnabled: config.streaming.enabled && config.streaming.reasoning,
        verbose: opts.verbose,
        reasoningLines: config.streaming.reasoningLines,
        proseLines: config.streaming.proseLines,
        fuckit: permsDisabled,
        permissions: rules,
        openModelPickerOnStart,
        onStartupCancel,
        restoreCandidate,
        onRestoreTodos: (snap) => {
          runtime.seedTodoList(session.id, snap.todos);
          log.append({
            sessionId: snap.sessionId,
            type: "todo_restore",
            payload: { sourceSessionId: snap.sessionId, action: "restored" },
          });
        },
        listProjectDir: () => {
          try {
            return readdirSync(projectDir);
          } catch {
            return [];
          }
        },
        onDismissTodos: (snap) => {
          log.append({
            sessionId: snap.sessionId,
            type: "todo_restore",
            payload: { sourceSessionId: snap.sessionId, action: "dismissed" },
          });
        },
        orchestrator,
        orchestration: config.orchestration,
        orchestrationDisplayRegister: (set) => {
          notifyOrchestrationChanged = set;
        },
        getPlanContext,
        projectDir,
        launchScope: scope.label,
      }),
    ),
    // Ctrl+C belongs to the prompt editor (clear input). `/quit` remains the
    // explicit way to end the TUI, while Escape cancels an in-flight turn.
    { exitOnCtrlC: false, stdout: frameWriter.stream },
  );
  unmountApp = unmount;

  const onCrash = makeCrashHandler({
    unmount: () => unmountApp?.(),
    logError: (message) =>
      log.append({ sessionId: session.id, type: "error", payload: { phase: "uncaught", message } }),
    write: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  });
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", (reason) => onCrash(reason));

  if (permsDisabled) console.error("[cleetus] WARNING: permissions disabled (--fuckit)");

  await waitUntilExit();
  // Ink's final frame (log.done) is still buffered at this point; stop intercepting so the
  // shutdown messages below go straight to the terminal.
  frameWriter.dispose();
  if (startupCancelled) console.log("No model selected. Quitting.");
  diagnosticsSeedController.abort();
  await sandbox.dispose();
  await mcp.shutdown();
  vectorService.close();
  codeManifest.close();
  log.close();
  db.close();
  return 0;
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof CleetusError ? e.message : (e as Error).message);
    process.exit(1);
  });
