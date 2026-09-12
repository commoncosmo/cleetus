import { join } from "node:path";
import { resolveAttachmentPaths, storeImage } from "../agent/attachments";
import type { AgentRuntime } from "../agent/runtime";
import type { SessionHistoryStore } from "../agent/session-history";
import { DEFAULT_RESIZE, type ResizeConfig } from "../config/resize";
import { DEFAULT_VISION, type VisionConfig } from "../config/vision";
import type { EventLog } from "../events/log";
import { McpManager, createStdioConnection } from "../mcp";
import type { McpServerStatus } from "../mcp/types";
import type { PermissionRules } from "../permission/types";
import type { ImageRef } from "../providers/types";
import { gateVision } from "../providers/vision";
import type { Sandbox } from "../sandbox/types";
import type { ToolRegistry } from "../tools/registry";
import {
  type ClientCapabilities,
  clientSupportsFsRead,
  clientSupportsFsWrite,
  clientSupportsTerminal,
} from "./capabilities";
import type { AcpCommandHandler } from "./commands";
import { deriveStopReason, eventToUpdate, isCapStop } from "./event-bridge";
import { AcpFileBridge, DirectFileBridge } from "./file-bridge";
import { historyToUpdates } from "./load-replay";
import { acpMcpServersToConfigs } from "./mcp-config";
import { type PermissionClient, type SessionGrants, makeAcpResolvePermission } from "./permission";
import { composeAcpPrompt } from "./prompt-content";
import type { FileBridgeHolder, PermissionRouter, PlanModeHolder, SandboxHolder } from "./runtime";
import type { AcpSessions } from "./session";
import type { AcpSessionConfigController, ActiveAcpSessionHolder } from "./session-config";
import { AcpSandbox } from "./terminal-sandbox";
import type { AcpTransport } from "./transport";
import { AcpTurnQueue } from "./turn-queue";
import {
  type WorkflowAuthorizationRouter,
  makeAcpWorkflowAuthorization,
} from "./workflow-permission";

const ACP_SESSION_MODES = [
  {
    id: "default",
    name: "Default",
    description: "Work normally and request permission for protected actions",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Investigate read-only and propose a plan before editing",
  },
] as const;

/** The cwd a session runs in: a process launch scope pins it, else the client-provided cwd, else
 *  the process cwd. */
export function pinnedOrParamCwd(
  pinnedCwd: string | undefined,
  paramCwd: unknown,
  fallback: string,
): string {
  return pinnedCwd ?? String(paramCwd ?? fallback);
}

function sessionModeState(modeId: string): {
  currentModeId: string;
  availableModes: { id: string; name: string; description: string }[];
} {
  return {
    currentModeId: modeId,
    availableModes: ACP_SESSION_MODES.map((mode) => ({ ...mode })),
  };
}

export interface SessionMethodDeps {
  runtime: AgentRuntime;
  log: EventLog;
  sessions: AcpSessions;
  permissionRouter: PermissionRouter;
  workflowAuthorizationRouter?: WorkflowAuthorizationRouter;
  /** Optional — defaults to a DirectFileBridge holder (disk). */
  fileBridgeHolder?: FileBridgeHolder;
  /** Optional — defaults to empty caps (no fs routing). */
  clientCapsRef?: { current: ClientCapabilities };
  /** Optional — mutable holder swapped to AcpSandbox when terminal cap is advertised. */
  sandboxHolder?: SandboxHolder;
  /** Optional — the real sandbox to reset sandboxHolder to after each turn. */
  fallbackSandbox?: Sandbox;
  /** Optional — restores per-session snapshots for `session/load`. Without it, load is a no-op. */
  historyStore?: SessionHistoryStore;
  /** Optional — shared tool registry that client MCP servers register their tools into. */
  tools?: ToolRegistry;
  /** Optional — mutable plan-mode flag flipped by `session/set_mode`. */
  planModeHolder?: PlanModeHolder;
  /** Optional — per-cwd persisted rules (project layer from the session's cwd, global shared);
   *  only DENY outcomes are honored. */
  rulesForCwd?: (cwd: string) => Promise<PermissionRules>;
  /** Optional — silently-degraded sandbox consent state; undefined when not degraded. */
  degradedConsent?: { acked: boolean; persistAck: () => void };
  /** Forward runtime events marked verbose-only to the ACP client. */
  verbose?: boolean;
  /** Advertised slash commands executable through the normal `session/prompt` path. */
  commands?: AcpCommandHandler;
  /** ACP-native per-session configuration options and their live runtime state. */
  sessionConfig?: AcpSessionConfigController;
  /** Selects which session's configuration runtime closures should read. */
  activeSessionHolder?: ActiveAcpSessionHolder;
  /** Publishes the current aggregate MCP status for one session to command/UI surfaces. */
  onMcpStatus?: (sessionId: string, statuses: McpServerStatus[]) => void;
  /** Cleetus-configured MCP server names. Client declarations with the same name are ignored so
   *  they cannot replace globally/project-configured tools in the shared registry. */
  configuredMcpServerNames?: ReadonlySet<string>;
  /** Connection-global serialization for runtime adapter swaps. Defaults to a fresh FIFO. */
  turnQueue?: AcpTurnQueue;
  /** Resolved vision settings gating/storing ACP image blocks. Defaults to DEFAULT_VISION. */
  vision?: VisionConfig;
  /** Resolved resize-on-ingest settings forwarded to `storeImage`/`resolveAttachmentPaths`. Defaults to DEFAULT_RESIZE. */
  resize?: ResizeConfig;
  /** Canonical-cwd repo map and quality-service selector, active only while the FIFO owns a turn. */
  projectContext?: {
    activate(cwd: string): Promise<void>;
    reset(): void;
  };
  /** Set when the process launched with `--global`/`--scratch`: pins every session's cwd to the
   *  launch dir, ignoring the client-provided `cwd`. Undefined for a normal project-scoped launch. */
  pinnedCwd?: string;
}

/** Register `session/new`, `session/prompt`, and `session/cancel` on the transport, driving the
 *  real `AgentRuntime.runTurn` and bridging its event stream to `session/update` notifications.
 *  Extracted from `runAcp` so it can be exercised with a stub-provider runtime in tests. */
export function registerSessionMethods(
  transport: AcpTransport,
  deps: SessionMethodDeps,
): { shutdownMcp: () => Promise<void> } {
  const {
    runtime,
    log,
    sessions,
    permissionRouter,
    workflowAuthorizationRouter,
    fileBridgeHolder = { current: new DirectFileBridge() },
    clientCapsRef = { current: {} },
    sandboxHolder,
    fallbackSandbox,
    historyStore,
    tools,
    planModeHolder,
    rulesForCwd,
    degradedConsent,
    verbose = false,
    commands,
    sessionConfig,
    activeSessionHolder,
    onMcpStatus,
    configuredMcpServerNames = new Set(),
    turnQueue = new AcpTurnQueue(),
    projectContext,
    vision = DEFAULT_VISION,
    resize = DEFAULT_RESIZE,
    pinnedCwd,
  } = deps;
  const abortControllers = new Map<string, AbortController>();

  // Track every McpManager created from a client's `mcpServers` so we can shut them down when the
  // connection closes. Keyed by sessionId; a session can carry multiple (new + load) managers.
  const mcpManagers = new Map<string, McpManager[]>();

  // Per-session ACP mode id (e.g. "default" / "plan"). Mirrored into planModeHolder when present.
  const sessionModes = new Map<string, string>();

  function advertiseCommands(sessionId: string): void {
    if (!commands) return;
    transport.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: commands.availableCommands(),
      },
    });
  }

  /** Connect any client-provided MCP servers and register their tools into the shared registry.
   *  No-op when there's no registry, the input isn't a non-empty server array, or all malformed. */
  async function connectClientMcp(sessionId: string, rawServers: unknown): Promise<void> {
    if (!tools) return;
    const servers = acpMcpServersToConfigs(rawServers, configuredMcpServerNames);
    if (servers.length === 0) return;
    const mcp = new McpManager({ servers, factory: createStdioConnection, log, timeoutMs: 10_000 });
    await mcp.connectAll();
    mcp.registerInto(tools);
    const list = mcpManagers.get(sessionId) ?? [];
    list.push(mcp);
    mcpManagers.set(sessionId, list);
    onMcpStatus?.(
      sessionId,
      list.flatMap((manager) => manager.status()),
    );
  }

  // Persist session grants across turns of the same session. `allow_always` adds a whole-tool grant;
  // an "allow edits in <dir>" choice adds an absolute path prefix. Both short-circuit future checks.
  const grantsBySession = new Map<string, SessionGrants>();

  // One PermissionClient per connection — routes `requestPermission` calls to the ACP client.
  const permissionClient: PermissionClient = {
    requestPermission: (req) =>
      transport.request("session/request_permission", req) as Promise<{
        outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
      }>,
  };

  transport.onRequest("session/new", async (params) => {
    const cwd = pinnedOrParamCwd(
      pinnedCwd,
      (params as { cwd?: string } | null)?.cwd,
      process.cwd(),
    );
    const sessionId = sessions.create(cwd);
    sessionModes.set(sessionId, "default");
    sessionConfig?.ensure(sessionId);
    await connectClientMcp(sessionId, (params as { mcpServers?: unknown } | null)?.mcpServers);
    advertiseCommands(sessionId);
    return {
      sessionId,
      modes: sessionModeState("default"),
      ...(sessionConfig ? { configOptions: sessionConfig.options(sessionId) } : {}),
    };
  });

  // `session/load`: restore a persisted snapshot and replay its user/assistant prose as
  // `session/update` notifications, then resolve `null`. Registers the session (so subsequent
  // prompts/cancels resolve) and connects any client MCP servers. A missing snapshot is an empty
  // replay — still a valid load.
  transport.onRequest("session/load", async (params) => {
    const p = params as { sessionId?: string; mcpServers?: unknown; cwd?: string } | null;
    const sessionId = String(p?.sessionId ?? "");
    sessions.adopt(sessionId, pinnedOrParamCwd(pinnedCwd, p?.cwd, process.cwd()));
    const modeId = sessionModes.get(sessionId) ?? "default";
    sessionModes.set(sessionId, modeId);
    sessionConfig?.ensure(sessionId);
    await connectClientMcp(sessionId, p?.mcpServers);
    const snap = historyStore?.load(sessionId);
    if (snap) {
      // Seed the runtime's in-memory history so a subsequent session/prompt continues
      // the restored conversation rather than starting from blank history.
      runtime.loadSession(sessionId, snap.messages, snap.todos);
      for (const update of historyToUpdates(snap.messages)) {
        transport.notify("session/update", { sessionId, update });
      }
    }
    advertiseCommands(sessionId);
    return {
      modes: sessionModeState(modeId),
      ...(sessionConfig ? { configOptions: sessionConfig.options(sessionId) } : {}),
    };
  });

  // `session/set_mode`: track the ACP mode id per session and emit a `current_mode_update`. When a
  // planModeHolder is wired, `modeId === "plan"` toggles cleetus's real plan mode so mutating tools
  // are blocked on the next turn.
  transport.onRequest("session/set_mode", async (params) => {
    const p = params as { sessionId?: string; modeId?: string } | null;
    const sessionId = String(p?.sessionId ?? "");
    const modeId = String(p?.modeId ?? "default");
    if (abortControllers.has(sessionId)) {
      throw new Error("cannot change session mode while a prompt is running");
    }
    if (!ACP_SESSION_MODES.some((mode) => mode.id === modeId)) {
      throw new Error(
        `unknown session mode '${modeId}'. available: ${ACP_SESSION_MODES.map((mode) => mode.id).join(", ")}`,
      );
    }
    sessionModes.set(sessionId, modeId);
    transport.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: modeId },
    });
    return null;
  });

  transport.onRequest("session/set_config_option", async (params) => {
    if (!sessionConfig) throw new Error("session configuration is unavailable");
    const p = params as { sessionId?: string; configId?: string; value?: unknown } | null;
    const sessionId = String(p?.sessionId ?? "");
    const configId = String(p?.configId ?? "");
    if (abortControllers.has(sessionId)) {
      throw new Error("cannot change session configuration while a prompt is running");
    }
    return {
      configOptions: sessionConfig.set(sessionId, configId, p?.value),
    };
  });

  // `session/clear`: empty the session's model-facing context (keeps the session id), matching the
  // terminal's `/clear`. Persists the now-empty history so a later `session/load` reflects it.
  // Refused while a turn is in flight (mutates nothing).
  transport.onRequest("session/clear", async (params) => {
    const sessionId = String((params as { sessionId?: string } | null)?.sessionId ?? "");
    if (abortControllers.has(sessionId)) return { ok: false, reason: "busy" };
    runtime.resetHistory(sessionId);
    runtime.snapshotSession(sessionId);
    return { ok: true };
  });

  // `session/compact`: fold the session's older context into a summary (keeps the visible
  // conversation), matching the terminal's `/compact`. Returns the runtime's stats under `stats`.
  // Persists the folded history; refused while a turn is in flight.
  transport.onRequest("session/compact", async (params) => {
    const p = params as { sessionId?: string; instruction?: string } | null;
    const sessionId = String(p?.sessionId ?? "");
    if (abortControllers.has(sessionId)) return { ok: false, reason: "busy" };
    const instruction =
      typeof p?.instruction === "string" && p.instruction.trim() ? p.instruction.trim() : undefined;
    return turnQueue.run(async () => {
      if (activeSessionHolder) activeSessionHolder.current = sessionId;
      try {
        await projectContext?.activate(sessions.cwd(sessionId) ?? process.cwd());
        const stats = await runtime.compactNow(sessionId, instruction);
        runtime.snapshotSession(sessionId);
        return { ok: true, stats };
      } finally {
        projectContext?.reset();
        if (activeSessionHolder) activeSessionHolder.current = null;
      }
    });
  });

  transport.onRequest("session/prompt", async (params) => {
    const { sessionId, prompt } = params as {
      sessionId: string;
      prompt: { type: string; text?: string }[];
    };
    const composedPrompt = composeAcpPrompt(prompt);
    let text = composedPrompt.text;
    if (abortControllers.has(sessionId)) {
      throw new Error(`session '${sessionId}' already has a prompt in flight`);
    }
    const ac = new AbortController();
    abortControllers.set(sessionId, ac);
    try {
      return await turnQueue.run(async () => {
        // Cancellation can arrive while this turn is waiting behind another session. Do not
        // install adapters or execute a command/model turn after its queued request was cancelled.
        if (ac.signal.aborted) return { stopReason: "cancelled" };
        let capped = false;
        const unsub = log.subscribe(sessionId, (event) => {
          if (isCapStop(event)) capped = true;
          const update = eventToUpdate(event, verbose);
          if (update) transport.notify("session/update", { sessionId, update });
        });
        try {
          if (activeSessionHolder) activeSessionHolder.current = sessionId;
          if (planModeHolder) planModeHolder.current = sessionModes.get(sessionId) === "plan";
          const sessionCwd = sessions.cwd(sessionId) ?? process.cwd();
          // Loaded once per cwd (cached) — a broken permissions.yaml fails this prompt loudly
          // rather than silently dropping persisted denies.
          const sessionRules = rulesForCwd ? await rulesForCwd(sessionCwd) : undefined;

          // Ensure a persistent grant set exists for this session, then install a per-turn resolver.
          if (!grantsBySession.has(sessionId)) {
            grantsBySession.set(sessionId, {
              tools: new Set<string>(),
              prefixes: [],
              denials: [],
              bashPrefixes: [],
            });
          }
          const grants = grantsBySession.get(sessionId)!;
          permissionRouter.current = makeAcpResolvePermission(
            permissionClient,
            sessionId,
            grants,
            sessionCwd,
            {
              rules: sessionRules,
              persistPath: join(sessionCwd, ".cleetus", "permissions.yaml"),
              degraded: degradedConsent,
            },
          );
          if (workflowAuthorizationRouter) {
            workflowAuthorizationRouter.current = makeAcpWorkflowAuthorization(
              permissionClient,
              sessionId,
            );
          }

          // Install a per-turn FileBridge routing reads/writes through the client when the client
          // advertised the matching fs capability.
          const caps = clientCapsRef.current;
          const requestFn = (m: string, p: unknown) => transport.request(m, p);
          const supportsRead = clientSupportsFsRead(caps);
          const supportsWrite = clientSupportsFsWrite(caps);
          if (supportsRead || supportsWrite) {
            const acpBridge = new AcpFileBridge(requestFn, sessionId);
            const diskBridge = new DirectFileBridge();
            fileBridgeHolder.current = {
              readTextFile: supportsRead
                ? (p) => acpBridge.readTextFile(p)
                : (p) => diskBridge.readTextFile(p),
              writeTextFile: supportsWrite
                ? (p, c) => acpBridge.writeTextFile(p, c)
                : (p, c) => diskBridge.writeTextFile(p, c),
            };
          }

          // Install the ACP terminal sandbox for this turn when the client advertised `terminal`.
          if (sandboxHolder && fallbackSandbox && clientSupportsTerminal(caps)) {
            process.stderr.write(
              `[cleetus/acp] sandbox bypass: routing command execution through client terminal for session ${sessionId}\n`,
            );
            sandboxHolder.current = new AcpSandbox(requestFn, sessionId, fallbackSandbox);
          }

          await projectContext?.activate(sessionCwd);
          if (ac.signal.aborted) return { stopReason: "cancelled" };
          const command = composedPrompt.textOnly
            ? await commands?.execute(text, { sessionId, signal: ac.signal })
            : null;
          if (command?.kind === "text") {
            transport.notify("session/update", {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: command.text },
              },
            });
            return {
              stopReason: ac.signal.aborted ? "cancelled" : "end_turn",
            };
          }
          if (command?.kind === "handled") {
            return {
              stopReason: ac.signal.aborted ? "cancelled" : "end_turn",
            };
          }
          if (command?.kind === "agent-turn") text = command.prompt;

          // Surfaces a dropped/degraded image (storeImage's error/warning, or
          // resolveAttachmentPaths' errors/warnings) to the client the same way command text is
          // sent below — as an agent_message_chunk — so a bad attachment isn't silently discarded.
          const notifyImageIssue = (text: string) => {
            transport.notify("session/update", {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `[image] ${text}` },
              },
            });
          };
          const attachDir = join(sessionCwd, ".cleetus", "attachments");
          const acpRefs: ImageRef[] = [];
          for (const candidate of composedPrompt.images) {
            if (acpRefs.length >= vision.maxPerTurn) break;
            if (candidate.base64) {
              const { ref, error, warning } = await storeImage(
                Buffer.from(candidate.base64, "base64"),
                vision,
                attachDir,
                resize,
              );
              if (error) notifyImageIssue(error);
              else if (warning) notifyImageIssue(warning);
              if (ref) acpRefs.push(ref);
            } else if (candidate.path) {
              const { refs, errors, warnings } = await resolveAttachmentPaths(
                [candidate.path],
                vision,
                attachDir,
                resize,
              );
              for (const e of errors) notifyImageIssue(e);
              for (const w of warnings) notifyImageIssue(w);
              for (const ref of refs) {
                if (acpRefs.length >= vision.maxPerTurn) break;
                acpRefs.push(ref);
              }
            }
          }

          // Vision gate: probe the active model and apply the same block/warn policy as TUI/CLI.
          // `acpRefs` is const; carry the gated set separately so `block` can drop to text-only.
          let imagesToSend = acpRefs;
          if (acpRefs.length > 0) {
            const { support, model } = await runtime.visionSupportForActiveModel();
            const gate = gateVision(support, model, vision);
            if (gate.action === "block") {
              notifyImageIssue(`${gate.message} Sending your message without the image(s).`);
              imagesToSend = [];
            } else if (gate.action === "warn") {
              notifyImageIssue(gate.message ?? "sending images anyway");
            }
          }

          const result = await runtime.runTurn(
            sessionId,
            text,
            ac.signal,
            undefined,
            undefined,
            imagesToSend,
          );
          return {
            stopReason: deriveStopReason({
              aborted: ac.signal.aborted,
              capped,
              failed: result.stoppedReason === "permission_error",
            }),
          };
        } finally {
          unsub();
          // Reset to safe defaults before the FIFO admits the next turn.
          projectContext?.reset();
          permissionRouter.current = async () => "deny";
          if (workflowAuthorizationRouter) {
            workflowAuthorizationRouter.current = async () => "deny";
          }
          fileBridgeHolder.current = new DirectFileBridge();
          if (sandboxHolder && fallbackSandbox) sandboxHolder.current = fallbackSandbox;
          if (planModeHolder) planModeHolder.current = false;
          if (activeSessionHolder) activeSessionHolder.current = null;
        }
      });
    } finally {
      abortControllers.delete(sessionId);
    }
  });

  // ACP `session/cancel` is a notification (no response). Abort the in-flight turn.
  transport.onRequest("session/cancel", async (params) => {
    const sessionId = String((params as { sessionId?: string } | null)?.sessionId ?? "");
    abortControllers.get(sessionId)?.abort();
    return null;
  });

  return {
    shutdownMcp: async () => {
      const all = [...mcpManagers.values()].flat();
      mcpManagers.clear();
      await Promise.all(all.map((m) => m.shutdown()));
    },
  };
}
