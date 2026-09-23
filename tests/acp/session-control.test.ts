import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSessions } from "../../src/acp/session";
import { registerSessionMethods } from "../../src/acp/session-methods";
import { AcpTransport } from "../../src/acp/transport";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { SessionHistoryStore } from "../../src/agent/session-history";
import { EventLog } from "../../src/events/log";
import { openDatabase } from "../../src/lib/db";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

/** Streams plain text then stops. */
class TextProvider implements Provider {
  constructor(private readonly chunks: string[]) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_req: ChatOptions): AsyncGenerator<StreamEvent> {
    for (const t of this.chunks) yield { type: "text-delta", text: t };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Hangs until aborted so a turn stays in flight (to test the busy guard). */
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

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-acpctl-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(provider: Provider, historyStore?: SessionHistoryStore): AgentRuntime {
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
    historyStore,
  });
}

interface Outbound {
  method?: string;
  id?: number;
  params?: { sessionId?: string; update?: { sessionUpdate?: string; content?: { text?: string } } };
  result?: Record<string, unknown> | null;
}

function wire(runtime: AgentRuntime, historyStore?: SessionHistoryStore) {
  const out: Outbound[] = [];
  const transport = new AcpTransport({ write: (line) => out.push(JSON.parse(line)) });
  const sessions = new AcpSessions();
  const permissionRouter = { current: async () => "deny" as const };
  registerSessionMethods(transport, { runtime, log, sessions, permissionRouter, historyStore });
  const send = (id: number, method: string, params: unknown) =>
    transport.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return { out, send };
}

describe("session/clear", () => {
  it("resets history + snapshots, returns { ok: true }; a later session/load replays nothing", async () => {
    const store = new SessionHistoryStore(openDatabase(join(dir, "hist.db")));
    const runtime = makeRuntime(new TextProvider(["hi there"]), store);
    const { out, send } = wire(runtime, store);

    await send(1, "session/new", { cwd: dir });
    const sid = out.find((m) => m.id === 1)?.result?.sessionId as string;
    await send(2, "session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "hello" }] });
    expect(runtime.getMessages(sid).length).toBeGreaterThan(0);
    // runTurn's finally persisted the turn — the store has real content BEFORE clear (guards the
    // load-replay assertion below against a false positive where nothing was ever persisted).
    expect((store.load(sid)?.messages ?? []).length).toBeGreaterThan(0);

    await send(3, "session/clear", { sessionId: sid });
    expect(out.find((m) => m.id === 3)?.result).toEqual({ ok: true });
    expect(runtime.getMessages(sid)).toHaveLength(0);
    // snapshotSession persisted the now-empty history over the prior content.
    expect(store.load(sid)?.messages ?? []).toHaveLength(0);

    // The invariant, end to end: a subsequent session/load replays no prose.
    const before = out.length;
    await send(4, "session/load", { sessionId: sid, cwd: dir });
    const replays = out
      .slice(before)
      .filter((m) => m.method === "session/update" && m.params?.sessionId === sid);
    expect(replays).toHaveLength(0);
  });

  it("refuses with { ok: false, reason: 'busy' } while a turn is in flight and mutates no history", async () => {
    const runtime = makeRuntime(new HangProvider());
    const { out, send } = wire(runtime);
    await send(1, "session/new", { cwd: dir });
    const sid = out.find((m) => m.id === 1)?.result?.sessionId as string;

    const prompt = send(2, "session/prompt", {
      sessionId: sid,
      prompt: [{ type: "text", text: "x" }],
    });
    await new Promise((r) => setTimeout(r, 10)); // let the turn register its AbortController
    await send(3, "session/clear", { sessionId: sid });

    expect(out.find((m) => m.id === 3)?.result).toEqual({ ok: false, reason: "busy" });
    expect(runtime.getMessages(sid).length).toBeGreaterThan(0); // user message still present

    // Clean up the hung turn.
    await send(4, "session/cancel", { sessionId: sid });
    await prompt;
  });
});

describe("session/load client MCP acknowledgement", () => {
  it("reports the tools connected for this load and exposes filtered-name collisions", async () => {
    const out: Outbound[] = [];
    const transport = new AcpTransport({ write: (line) => out.push(JSON.parse(line)) });
    const tools = new ToolRegistry();
    const registered = registerSessionMethods(transport, {
      runtime: makeRuntime(new TextProvider([])),
      log,
      sessions: new AcpSessions(),
      permissionRouter: { current: async () => "deny" as const },
      tools,
      configuredMcpServerNames: new Set(["reserved"]),
    });
    const send = (id: number, params: unknown) =>
      transport.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method: "session/load", params }));
    try {
      await send(1, {
        sessionId: "sess-mcp",
        cwd: dir,
        mcpServers: [
          {
            name: "echo",
            command: process.execPath,
            args: [join(import.meta.dir, "..", "mcp", "fixtures", "echo-server.ts")],
            env: [],
          },
        ],
      });
      const connected = out.find((message) => message.id === 1)?.result?._meta as {
        "commoncosmo.com": {
          cleetus: {
            clientMcp: {
              version: number;
              servers: Array<{ name: string; state: string; toolNames: string[] }>;
            };
          };
        };
      };
      expect(connected["commoncosmo.com"].cleetus.clientMcp).toMatchObject({
        version: 1,
        servers: [
          {
            name: "echo",
            state: "connected",
            toolNames: expect.arrayContaining(["mcp__echo__echo"]),
          },
        ],
      });
      expect(tools.get("mcp__echo__echo")).toBeDefined();

      await send(2, {
        sessionId: "sess-mcp",
        cwd: dir,
        mcpServers: [{ name: "reserved", command: "/ignored", args: [], env: [] }],
      });
      expect(out.find((message) => message.id === 2)?.result?._meta).toEqual({
        "commoncosmo.com": { cleetus: { clientMcp: { version: 1, servers: [] } } },
      });
    } finally {
      await registered.shutdownMcp();
    }
  });
});

describe("session/compact", () => {
  it("passes the instruction through, returns { ok: true, stats }, and snapshots after compacting", async () => {
    const runtime = makeRuntime(new TextProvider([]));
    const calls: string[] = [];
    let seenInstruction: string | undefined = "UNSET";
    const stats = {
      compacted: true,
      messagesFolded: 3,
      beforeTokens: 8000,
      afterTokens: 2000,
      partial: false,
    };
    runtime.compactNow = (async (_sid: string, instruction?: string) => {
      seenInstruction = instruction;
      calls.push("compact");
      return stats;
    }) as typeof runtime.compactNow;
    runtime.snapshotSession = ((_sid: string) => {
      calls.push("snapshot");
    }) as typeof runtime.snapshotSession;

    const { out, send } = wire(runtime);
    await send(1, "session/new", { cwd: dir });
    const sid = out.find((m) => m.id === 1)?.result?.sessionId as string;
    await send(2, "session/compact", { sessionId: sid, instruction: "focus on the API" });

    expect(out.find((m) => m.id === 2)?.result).toEqual({ ok: true, stats });
    expect(seenInstruction).toBe("focus on the API");
    expect(calls).toEqual(["compact", "snapshot"]); // snapshot AFTER compact (the invariant)
  });

  it("normalizes a blank/absent instruction to undefined", async () => {
    const runtime = makeRuntime(new TextProvider([]));
    let seen: string | undefined = "UNSET";
    runtime.compactNow = (async (_sid: string, instruction?: string) => {
      seen = instruction;
      return {
        compacted: false,
        messagesFolded: 0,
        beforeTokens: 5,
        afterTokens: 5,
        partial: false,
      };
    }) as typeof runtime.compactNow;

    const { out, send } = wire(runtime);
    await send(1, "session/new", { cwd: dir });
    const sid = out.find((m) => m.id === 1)?.result?.sessionId as string;
    await send(2, "session/compact", { sessionId: sid, instruction: "   " });
    expect(seen).toBeUndefined();
  });

  it("refuses with { ok: false, reason: 'busy' } while a turn is in flight and never calls compactNow", async () => {
    const runtime = makeRuntime(new HangProvider());
    let compactCalled = false;
    const realCompact = runtime.compactNow.bind(runtime);
    runtime.compactNow = (async (sid: string, instr?: string) => {
      compactCalled = true;
      return realCompact(sid, instr);
    }) as typeof runtime.compactNow;

    const { out, send } = wire(runtime);
    await send(1, "session/new", { cwd: dir });
    const sid = out.find((m) => m.id === 1)?.result?.sessionId as string;
    const prompt = send(2, "session/prompt", {
      sessionId: sid,
      prompt: [{ type: "text", text: "x" }],
    });
    await new Promise((r) => setTimeout(r, 10));
    await send(3, "session/compact", { sessionId: sid });

    expect(out.find((m) => m.id === 3)?.result).toEqual({ ok: false, reason: "busy" });
    expect(compactCalled).toBe(false);

    await send(4, "session/cancel", { sessionId: sid });
    await prompt;
  });
});
