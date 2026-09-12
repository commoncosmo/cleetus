import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpCommandHandler } from "../../src/acp/commands";
import { AcpSessions } from "../../src/acp/session";
import {
  type AcpSessionConfigController,
  type ActiveAcpSessionHolder,
  createAcpSessionConfig,
} from "../../src/acp/session-config";
import { registerSessionMethods } from "../../src/acp/session-methods";
import { AcpTransport } from "../../src/acp/transport";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { SessionHistoryStore } from "../../src/agent/session-history";
import { EventLog } from "../../src/events/log";
import { openDatabase } from "../../src/lib/db";
import type { PermissionRules } from "../../src/permission/types";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

describe("AcpSessions", () => {
  it("creates a unique session id per cwd and tracks it", () => {
    const s = new AcpSessions();
    const id1 = s.create("/proj");
    const id2 = s.create("/proj");
    expect(id1).not.toBe(id2);
    expect(s.has(id1)).toBe(true);
    expect(s.has("nope")).toBe(false);
    expect(s.cwd(id1)).toBe("/proj");
  });
});

/** Tool-free provider: streams plain text then stops. No tool schemas are exercised, so the
 *  temporary deny resolvePermission placeholder is never hit. */
class TextProvider implements Provider {
  readonly requests: ChatOptions[] = [];

  constructor(private readonly chunks: string[]) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.requests.push(req);
    for (const t of this.chunks) yield { type: "text-delta", text: t };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-acp-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(provider: Provider): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "deny",
    maxToolLoops: 4,
  });
}

interface Outbound {
  method?: string;
  id?: number;
  params?: {
    sessionId?: string;
    update?: {
      sessionUpdate?: string;
      content?: { text?: string };
      currentModeId?: string;
      availableCommands?: {
        name: string;
        description: string;
        input?: { hint: string };
      }[];
    };
  };
  result?: {
    sessionId?: string;
    stopReason?: string;
    modes?: {
      currentModeId: string;
      availableModes: { id: string; name: string; description: string }[];
    };
    configOptions?: { id: string; currentValue: string }[];
  } | null;
}

/** Build a transport that captures outbound writes, wired to the session methods over a
 *  stub-provider runtime. Returns helpers to drive inbound JSON-RPC. */
function wire(
  provider: Provider,
  historyStore?: SessionHistoryStore,
  rulesForCwd?: (cwd: string) => Promise<PermissionRules>,
  commands?: AcpCommandHandler,
  sessionConfig?: AcpSessionConfigController,
  activeSessionHolder?: ActiveAcpSessionHolder,
  projectContext?: { activate(cwd: string): Promise<void>; reset(): void },
) {
  const out: Outbound[] = [];
  const transport = new AcpTransport({
    write: (line) => {
      out.push(JSON.parse(line));
    },
  });
  const sessions = new AcpSessions();
  const permissionRouter = { current: async () => "deny" as const };
  const runtime = makeRuntime(provider);
  registerSessionMethods(transport, {
    runtime,
    log,
    sessions,
    permissionRouter,
    historyStore,
    rulesForCwd,
    commands,
    sessionConfig,
    activeSessionHolder,
    projectContext,
  });
  const send = (id: number, method: string, params: unknown) =>
    transport.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const notify = (method: string, params: unknown) =>
    transport.handleLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  return { out, send, notify, runtime };
}

describe("ACP command advertisement and dispatch", () => {
  const commands: AcpCommandHandler = {
    availableCommands: () => [
      { name: "skill", description: "Run a skill", input: { hint: "<name> [arguments]" } },
    ],
    execute: async (input) =>
      input.trim() === "/skill" ? { kind: "text", text: "available skills: weather" } : null,
  };

  it("advertises executable commands after session/new", async () => {
    const { out, send } = wire(
      new TextProvider(["provider should not run"]),
      undefined,
      undefined,
      commands,
    );
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((message) => message.id === 1)?.result?.sessionId;
    const update = out.find(
      (message) =>
        message.method === "session/update" &&
        message.params?.update?.sessionUpdate === "available_commands_update",
    );
    expect(update?.params?.sessionId).toBe(sessionId);
    expect(update?.params?.update?.availableCommands).toEqual([
      {
        name: "skill",
        description: "Run a skill",
        input: { hint: "<name> [arguments]" },
      },
    ]);
    expect(out.find((message) => message.id === 1)?.result?.modes).toEqual({
      currentModeId: "default",
      availableModes: [
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
      ],
    });
  });

  it("executes a local command through session/prompt without starting a model turn", async () => {
    const { out, send, runtime } = wire(
      new TextProvider(["provider should not run"]),
      undefined,
      undefined,
      commands,
    );
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((message) => message.id === 1)?.result?.sessionId;
    await send(2, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/skill" }],
    });

    const commandText = out
      .filter(
        (message) =>
          message.method === "session/update" &&
          message.params?.update?.sessionUpdate === "agent_message_chunk",
      )
      .map((message) => message.params?.update?.content?.text ?? "")
      .join("");
    expect(commandText).toBe("available skills: weather");
    expect(out.find((message) => message.id === 2)?.result?.stopReason).toBe("end_turn");
    expect(runtime.getMessages(sessionId!)).toHaveLength(0);
  });

  it("replaces an agent-turn command with its seeded prompt before calling the model", async () => {
    const provider = new TextProvider(["spec ready"]);
    const seeded: AcpCommandHandler = {
      availableCommands: () => [
        { name: "spec", description: "Draft a specification", input: { hint: "[rough idea]" } },
      ],
      execute: async (input) =>
        input === "/spec notes app"
          ? { kind: "agent-turn", prompt: "seeded spec-creator turn" }
          : null,
    };
    const { out, send } = wire(provider, undefined, undefined, seeded);
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((message) => message.id === 1)?.result?.sessionId;
    await send(2, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/spec notes app" }],
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: "seeded spec-creator turn",
    });
  });

  it("passes embedded text resources to the model and does not treat mixed content as a command", async () => {
    const provider = new TextProvider(["reviewed"]);
    let commandCalls = 0;
    const commands: AcpCommandHandler = {
      availableCommands: () => [{ name: "skill", description: "Run a skill" }],
      execute: async () => {
        commandCalls++;
        return { kind: "text", text: "should not execute" };
      },
    };
    const { out, send } = wire(provider, undefined, undefined, commands);
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((message) => message.id === 1)?.result?.sessionId;
    await send(2, "session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "/skill review this:" },
        {
          type: "resource",
          resource: {
            uri: "file:///project/app.ts",
            mimeType: "text/typescript",
            text: "export const value = 1;",
          },
        },
      ],
    });

    expect(commandCalls).toBe(0);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages.at(-1)?.content).toContain(
      "[Embedded resource: file:///project/app.ts (text/typescript)]",
    );
    expect(provider.requests[0]?.messages.at(-1)?.content).toContain("export const value = 1;");
  });

  it("session/cancel aborts an asynchronous local command such as /learn", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const cancellable: AcpCommandHandler = {
      availableCommands: () => [
        { name: "learn", description: "Draft a playbook", input: { hint: "[status|save]" } },
      ],
      execute: async (_input, context) => {
        markStarted();
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) resolve();
          else context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { kind: "text", text: "Playbook drafting cancelled; nothing was written." };
      },
    };
    const { out, send, notify, runtime } = wire(
      new TextProvider(["provider should not run"]),
      undefined,
      undefined,
      cancellable,
    );
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((message) => message.id === 1)?.result?.sessionId;
    const prompt = send(2, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/learn" }],
    });
    await started;
    await notify("session/cancel", { sessionId });
    await prompt;

    expect(out.find((message) => message.id === 2)?.result?.stopReason).toBe("cancelled");
    expect(runtime.getMessages(sessionId!)).toHaveLength(0);
  });

  it("re-advertises commands after session/load", async () => {
    const store = new SessionHistoryStore(openDatabase(join(dir, "commands-history.db")));
    store.save("sess-commands", [], []);
    const { out, send } = wire(new TextProvider([]), store, undefined, commands);
    await send(1, "session/load", { sessionId: "sess-commands", cwd: dir });
    expect(
      out.some(
        (message) =>
          message.params?.sessionId === "sess-commands" &&
          message.params?.update?.sessionUpdate === "available_commands_update",
      ),
    ).toBe(true);
  });
});

describe("session/new + session/prompt end-to-end", () => {
  it("creates a session, streams agent_message_chunk updates, ends with end_turn", async () => {
    const { out, send } = wire(new TextProvider(["Hello ", "world"]));

    await send(1, "session/new", { cwd: dir });
    const created = out.find((m) => m.id === 1);
    const sessionId = created?.result?.sessionId;
    expect(typeof sessionId).toBe("string");

    await send(2, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    // At least one agent_message_chunk update was streamed for this session.
    const chunks = out.filter(
      (m) =>
        m.method === "session/update" &&
        m.params?.sessionId === sessionId &&
        m.params?.update?.sessionUpdate === "agent_message_chunk",
    );
    expect(chunks.length).toBeGreaterThan(0);
    const text = chunks.map((c) => c.params?.update?.content?.text ?? "").join("");
    expect(text).toContain("Hello");

    // The prompt response carries the stopReason.
    const promptResult = out.find((m) => m.id === 2);
    expect(promptResult?.result?.stopReason).toBe("end_turn");
  });

  it("session/cancel aborts the in-flight controller (returns cancelled)", async () => {
    // A provider that hangs until aborted so cancel has something to interrupt.
    class HangProvider implements Provider {
      async listModels() {
        return [{ id: "m" }];
      }
      async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "finish", reason: "stop" };
      }
      async embed() {
        return [0];
      }
    }
    const { out, send, notify } = wire(new HangProvider());
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((m) => m.id === 1)?.result?.sessionId;

    const promptDone = send(2, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    // Give the turn a tick to register its AbortController, then cancel.
    await new Promise((r) => setTimeout(r, 10));
    await notify("session/cancel", { sessionId });
    await promptDone;

    const promptResult = out.find((m) => m.id === 2);
    expect(promptResult?.result?.stopReason).toBe("cancelled");
  });

  it("serializes project-context activation across sessions on one connection", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstActive = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let commandCalls = 0;
    const commands: AcpCommandHandler = {
      availableCommands: () => [{ name: "hold", description: "Hold a turn" }],
      execute: async () => {
        commandCalls++;
        if (commandCalls === 1) {
          firstStarted();
          await firstBlocked;
        }
        return { kind: "text", text: "done" };
      },
    };
    const lifecycle: string[] = [];
    const projectContext = {
      async activate(cwd: string) {
        lifecycle.push(`activate:${cwd}`);
      },
      reset() {
        lifecycle.push("reset");
      },
    };
    const { out, send } = wire(
      new TextProvider([]),
      undefined,
      undefined,
      commands,
      undefined,
      undefined,
      projectContext,
    );
    await send(1, "session/new", { cwd: "/project-one" });
    await send(2, "session/new", { cwd: "/project-two" });
    const sessionIds = out
      .filter((message) => message.result?.sessionId)
      .map((message) => message.result!.sessionId!);

    const first = send(3, "session/prompt", {
      sessionId: sessionIds[0],
      prompt: [{ type: "text", text: "/hold" }],
    });
    await firstActive;
    const second = send(4, "session/prompt", {
      sessionId: sessionIds[1],
      prompt: [{ type: "text", text: "/hold" }],
    });
    await Promise.resolve();

    expect(lifecycle).toEqual(["activate:/project-one"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(lifecycle).toEqual(["activate:/project-one", "reset", "activate:/project-two", "reset"]);
  });

  it("does not start a queued turn after that session is cancelled", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstActive = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let commandCalls = 0;
    const commands: AcpCommandHandler = {
      availableCommands: () => [{ name: "hold", description: "Hold a turn" }],
      execute: async () => {
        commandCalls++;
        if (commandCalls === 1) {
          firstStarted();
          await firstBlocked;
        }
        return { kind: "text", text: "done" };
      },
    };
    const activated: string[] = [];
    const { out, send, notify } = wire(
      new TextProvider([]),
      undefined,
      undefined,
      commands,
      undefined,
      undefined,
      {
        async activate(cwd) {
          activated.push(cwd);
        },
        reset() {},
      },
    );
    await send(1, "session/new", { cwd: "/project-one" });
    await send(2, "session/new", { cwd: "/project-two" });
    const sessionIds = out
      .filter((message) => message.result?.sessionId)
      .map((message) => message.result!.sessionId!);

    const first = send(3, "session/prompt", {
      sessionId: sessionIds[0],
      prompt: [{ type: "text", text: "/hold" }],
    });
    await firstActive;
    const second = send(4, "session/prompt", {
      sessionId: sessionIds[1],
      prompt: [{ type: "text", text: "/hold" }],
    });
    await notify("session/cancel", { sessionId: sessionIds[1] });
    releaseFirst();
    await Promise.all([first, second]);

    expect(commandCalls).toBe(1);
    expect(activated).toEqual(["/project-one"]);
    expect(out.find((message) => message.id === 4)?.result?.stopReason).toBe("cancelled");
  });
});

describe("session/load + session/set_mode", () => {
  it("replays a snapshot's user/assistant prose and returns mode state", async () => {
    const store = new SessionHistoryStore(openDatabase(join(dir, "history.db")));
    store.save(
      "sess-1",
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      [],
    );
    const { out, send } = wire(new TextProvider([]), store);

    await send(1, "session/load", { sessionId: "sess-1", cwd: dir });

    const replays = out.filter(
      (m) => m.method === "session/update" && m.params?.sessionId === "sess-1",
    );
    expect(replays.map((r) => r.params?.update?.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
    expect(replays[0]?.params?.update?.content?.text).toBe("hi");
    expect(replays[1]?.params?.update?.content?.text).toBe("hello");

    const loadResult = out.find((m) => m.id === 1);
    expect(loadResult?.result?.modes?.currentModeId).toBe("default");
  });

  it("session/load with no snapshot returns mode state with no replay", async () => {
    const store = new SessionHistoryStore(openDatabase(join(dir, "history2.db")));
    const { out, send } = wire(new TextProvider([]), store);

    await send(1, "session/load", { sessionId: "missing", cwd: dir });

    const replays = out.filter((m) => m.method === "session/update");
    expect(replays).toHaveLength(0);
    expect(out.find((m) => m.id === 1)?.result?.modes?.currentModeId).toBe("default");
  });

  it("session/load seeds the runtime so a subsequent session/prompt continues the restored conversation", async () => {
    const store = new SessionHistoryStore(openDatabase(join(dir, "history3.db")));
    const priorMessages = [
      { role: "user" as const, content: "what is 2+2?" },
      { role: "assistant" as const, content: "It is 4." },
    ];
    store.save("sess-cont", priorMessages, []);

    const { send, runtime } = wire(new TextProvider(["sure"]), store);

    // Load the session — must seed the runtime's in-memory history.
    await send(1, "session/load", { sessionId: "sess-cont", cwd: dir });

    // Drive a follow-up prompt. The runtime must carry the prior messages in its history for
    // this session, not start from blank. We assert this BEFORE the turn merges new messages in,
    // by checking that the prior assistant message is present immediately after load (before prompt).
    const afterLoad = runtime.getMessages("sess-cont");
    expect(afterLoad).toHaveLength(2);
    expect(afterLoad[0]).toMatchObject({ role: "user", content: "what is 2+2?" });
    expect(afterLoad[1]).toMatchObject({ role: "assistant", content: "It is 4." });

    // Also confirm the post-prompt history includes the prior turns (i.e. the new turn extends them).
    await send(2, "session/prompt", {
      sessionId: "sess-cont",
      prompt: [{ type: "text", text: "what did you say before?" }],
    });
    const afterPrompt = runtime.getMessages("sess-cont");
    // History grows beyond the 2 seeded messages (new user + assistant turn appended).
    expect(afterPrompt.length).toBeGreaterThan(2);
    // The original restored messages are still present at the start.
    expect(afterPrompt[0]).toMatchObject({ role: "user", content: "what is 2+2?" });
    expect(afterPrompt[1]).toMatchObject({ role: "assistant", content: "It is 4." });
  });

  it("session/set_mode emits current_mode_update for the session", async () => {
    const { out, send } = wire(new TextProvider([]));
    await send(1, "session/set_mode", { sessionId: "s", modeId: "plan" });

    const update = out.find(
      (m) =>
        m.method === "session/update" && m.params?.update?.sessionUpdate === "current_mode_update",
    );
    expect(update?.params?.sessionId).toBe("s");
    expect(update?.params?.update?.currentModeId).toBe("plan");
    expect(out.find((m) => m.id === 1)?.result).toBe(null);
  });

  it("session/load returns the selected mode for an adopted session", async () => {
    const { out, send } = wire(new TextProvider([]));
    await send(1, "session/set_mode", { sessionId: "s", modeId: "plan" });
    await send(2, "session/load", { sessionId: "s", cwd: dir });
    expect(out.find((m) => m.id === 2)?.result?.modes?.currentModeId).toBe("plan");
  });

  it("rejects a mode that was not advertised", async () => {
    const { out, send } = wire(new TextProvider([]));
    await send(1, "session/set_mode", { sessionId: "s", modeId: "fuckit" });
    const response = out.find((m) => m.id === 1) as
      | (Outbound & { error?: { message?: string } })
      | undefined;
    expect(response?.error?.message).toContain("unknown session mode 'fuckit'");
  });

  it("session/prompt loads rules via rulesForCwd, keyed by the session's own cwd", async () => {
    const seenCwds: string[] = [];
    const rulesForCwd = async (cwd: string): Promise<PermissionRules> => {
      seenCwds.push(cwd);
      return { project: [], global: [] };
    };
    const { out, send } = wire(new TextProvider(["ok"]), undefined, rulesForCwd);

    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((m) => m.id === 1)?.result?.sessionId;

    await send(2, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    expect(seenCwds).toContain(dir);
  });

  it("a rejecting rulesForCwd surfaces as a JSON-RPC error and does not leak the AbortController", async () => {
    // Regression: rulesForCwd used to be awaited AFTER abortControllers.set(sessionId, ac), and
    // the await sat outside the try/finally that deletes the controller. A rejection here (e.g.
    // a broken permissions.yaml) correctly errored session/prompt, but left the controller
    // registered forever — a later session/clear (or session/compact) would then wrongly report
    // { ok: false, reason: "busy" } even though no turn was ever in flight.
    const rulesForCwd = async (): Promise<PermissionRules> => {
      throw new Error("broken permissions.yaml");
    };
    const { out, send } = wire(new TextProvider(["ok"]), undefined, rulesForCwd);

    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((m) => m.id === 1)?.result?.sessionId;

    await send(2, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    const promptResponse = out.find((m) => m.id === 2) as { error?: { message?: string } };
    expect(promptResponse?.error?.message).toContain("broken permissions.yaml");

    await send(3, "session/clear", { sessionId });
    const clearResponse = out.find((m) => m.id === 3) as { result?: { ok?: boolean } };
    expect(clearResponse?.result).toEqual({ ok: true });
  });
});

describe("session configuration options", () => {
  function configHarness() {
    const holder: ActiveAcpSessionHolder = { current: null };
    const config = createAcpSessionConfig({
      defaults: {
        active: { provider: "lm", model: "m" },
        persona: "coding",
        personality: "cleetus",
        effort: "medium",
        route: "manual",
        maxToolLoops: Number.POSITIVE_INFINITY,
      },
      catalog: [{ provider: "lm", models: ["m", "m2"] }],
      routingTiersAvailable: false,
      holder,
    });
    return { holder, config };
  }

  it("returns configOptions from session/new and applies session/set_config_option", async () => {
    const { holder, config } = configHarness();
    const { out, send } = wire(
      new TextProvider([]),
      undefined,
      undefined,
      undefined,
      config,
      holder,
    );
    await send(1, "session/new", { cwd: dir });
    const created = out.find((message) => message.id === 1)?.result;
    const sessionId = created?.sessionId;
    expect(created?.configOptions?.find((option) => option.id === "effort")?.currentValue).toBe(
      "medium",
    );

    await send(2, "session/set_config_option", {
      sessionId,
      configId: "effort",
      value: "high",
    });
    expect(
      out
        .find((message) => message.id === 2)
        ?.result?.configOptions?.find((option) => option.id === "effort")?.currentValue,
    ).toBe("high");
    expect(config.ensure(sessionId!).effort).toBe("high");
  });
});
