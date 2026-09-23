import { type JobRegistry, registerClientJobTools } from "../jobs";
import type { McpServerStatus } from "../mcp/types";
import {
  type ClientCapabilities,
  buildInitializeResult,
  clientJobCapabilities,
  negotiateProtocolVersion,
  parseClientCapabilities,
} from "./capabilities";
import { createAcpCommandHandler } from "./commands";
import { type AcpRuntimeOptions, buildAcpRuntime } from "./runtime";
import { AcpSessions } from "./session";
import { registerSessionMethods } from "./session-methods";
import { AcpTransport } from "./transport";

/** Register the `initialize` handler. Captures the client's capabilities for later fs/terminal
 *  routing decisions, negotiates the protocol version, and returns the agent's capabilities. */
export function registerInitialize(
  transport: AcpTransport,
  onInitialized: (caps: ClientCapabilities) => void,
): void {
  transport.onRequest("initialize", async (params) => {
    const caps = parseClientCapabilities(params);
    onInitialized(caps);
    const result = buildInitializeResult();
    result.protocolVersion = negotiateProtocolVersion(
      (params as { protocolVersion?: unknown } | null)?.protocolVersion,
    );
    return result;
  });
  // No auth methods are advertised, so the client should not call these — but register no-op
  // success handlers for conformance with clients that probe them.
  transport.onRequest("authenticate", async () => ({}));
  transport.onRequest("logout", async () => ({}));
}

/** Pump newline-delimited lines from a byte stream into the transport. Splits on "\n" and keeps
 *  a partial-line buffer between chunks. stderr is left for logging; never written to stdout.
 *
 *  Lines are dispatched WITHOUT awaiting the handler, so a long-running request (a `session/prompt`
 *  that awaits the whole turn) does not block the read loop. This is what lets a mid-turn
 *  `session/cancel` notification be read and processed while the turn is still streaming —
 *  awaiting each `handleLine` serially parked the loop on the in-flight prompt and stranded the
 *  cancel in the buffer until the turn finished on its own. `handleLine` never rejects (it sends a
 *  JSON-RPC error response internally), so the tracked promises resolve and a single handler's
 *  outbound writes stay correctly ordered; only independent messages run concurrently. We await
 *  any still-in-flight handlers once the stream closes so a turn isn't dropped on disconnect. */
export async function pumpStdin(
  transport: AcpTransport,
  stream: AsyncIterable<Uint8Array>,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  const inflight = new Set<Promise<void>>();
  const dispatch = (line: string) => {
    const p = transport.handleLine(line).finally(() => {
      inflight.delete(p);
    });
    inflight.add(p);
  };
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      dispatch(line);
      nl = buf.indexOf("\n");
    }
  }
  if (buf.trim() !== "") dispatch(buf);
  await Promise.all(inflight);
}

/** ACP subcommand entry point. Builds a transport writing to stdout, registers the initialize
 *  and session methods over a real AgentRuntime, and pumps stdin until the client closes it. */
export async function runAcp(opts: AcpRuntimeOptions): Promise<void> {
  const transport = new AcpTransport({
    write: (line) => process.stdout.write(line),
  });

  const bundle = await buildAcpRuntime(opts);

  // Shared ref that registerInitialize writes once; session/prompt reads per-turn.
  const clientCapsRef: { current: ClientCapabilities } = { current: {} };
  const jobRegistryRef: { current?: JobRegistry } = {};
  let jobToolsRegistered = false;
  registerInitialize(transport, (caps) => {
    clientCapsRef.current = caps;
    const jobCapabilities = clientJobCapabilities(caps);
    if (jobCapabilities && !jobToolsRegistered) {
      jobRegistryRef.current = registerClientJobTools({
        tools: bundle.tools,
        request: (method, params) => transport.request(method, params),
        capabilities: jobCapabilities,
        evidenceRegistry: bundle.evidenceRegistry,
      });
      jobToolsRegistered = true;
    }
  });

  const sessions = new AcpSessions();
  const mcpStatuses = new Map<string, McpServerStatus[]>();
  const { shutdownMcp } = registerSessionMethods(transport, {
    runtime: bundle.runtime,
    log: bundle.log,
    vision: bundle.vision,
    resize: bundle.resize,
    sessions,
    permissionRouter: bundle.permissionRouter,
    workflowAuthorizationRouter: bundle.workflowAuthorizationRouter,
    fileBridgeHolder: bundle.fileBridgeHolder,
    sandboxHolder: bundle.sandboxHolder,
    fallbackSandbox: bundle.realSandbox,
    clientCapsRef,
    jobRegistryRef,
    historyStore: bundle.historyStore,
    tools: bundle.tools,
    evidenceRegistry: bundle.evidenceRegistry,
    planModeHolder: bundle.planModeHolder,
    rulesForCwd: bundle.rulesForCwd,
    degradedConsent: bundle.degradedConsent,
    verbose: opts.verbose,
    sessionConfig: bundle.sessionConfig,
    activeSessionHolder: bundle.activeSessionHolder,
    projectContext: bundle.projectContext,
    pinnedCwd: bundle.launchScope.kind !== "project" ? bundle.projectDir : undefined,
    onMcpStatus: (sessionId, statuses) => {
      mcpStatuses.set(sessionId, statuses);
    },
    configuredMcpServerNames: bundle.configuredMcp.names,
    commands: createAcpCommandHandler(bundle.skills, {
      workflowController: bundle.workflowController,
      learnPlaybookForSession: bundle.learnPlaybookForSession,
      buildSpecSeed: bundle.buildSpecSeed,
      clearSession: (sessionId) => {
        bundle.runtime.resetHistory(sessionId);
        bundle.runtime.snapshotSession(sessionId);
      },
      compactSession: async (sessionId, instruction) => {
        const result = await bundle.runtime.compactNow(sessionId, instruction);
        bundle.runtime.snapshotSession(sessionId);
        return result;
      },
      getInstructions: () => bundle.instructions,
      memory: bundle.memory,
      getPermissions: async (sessionId) =>
        bundle.rulesForCwd(sessions.cwd(sessionId) ?? bundle.projectDir),
      getMcpStatus: (sessionId) => [
        ...bundle.configuredMcp.statuses,
        ...(mcpStatuses.get(sessionId) ?? []),
      ],
      getMaxLoops: (sessionId) => bundle.sessionConfig.ensure(sessionId).maxToolLoops,
      setMaxLoops: (sessionId, value) => {
        bundle.sessionConfig.ensure(sessionId).maxToolLoops = value;
      },
      getCheckpoints: bundle.projectCommands.getCheckpoints,
      rewindToCheckpoint: bundle.projectCommands.rewindToCheckpoint,
      runInsights: bundle.projectCommands.runInsights,
      runReview: bundle.projectCommands.runReview,
      runIndex: bundle.projectCommands.runIndex,
    }),
  });

  try {
    // Bun's ReadableStream is async-iterable at runtime, but the DOM lib types don't declare it.
    await pumpStdin(transport, Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>);
  } finally {
    await shutdownMcp();
    await bundle.dispose();
  }
}
