import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pumpStdin } from "../../src/acp/server";
import { AcpSessions } from "../../src/acp/session";
import { registerSessionMethods } from "../../src/acp/session-methods";
import { AcpTransport } from "../../src/acp/transport";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

// Regression for the pumpStdin serialization bug: the desktop chat's Stop/ESC sends
// `session/cancel` mid-turn, but the server read its stdin serially with `await handleLine(line)`
// — so while the `session/prompt` handler awaited the whole turn, the cancel line sat unread in
// the buffer until the turn finished naturally. This drives the real `pumpStdin` loop (the
// existing session/cancel test calls handleLine directly and never exercises the loop).

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-acp-cancel-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

/** A provider whose turn hangs until the abort signal fires — so a cancel has something to
 *  interrupt, and a turn that is NEVER cancelled would hang forever (proving the cancel landed). */
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

/** A controllable byte stream the test pushes newline-framed JSON-RPC lines into. */
function pushableStream() {
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  let wake: (() => void) | null = null;
  let closed = false;
  const stream = (async function* () {
    while (true) {
      if (chunks.length) {
        yield chunks.shift()!;
        continue;
      }
      if (closed) return;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  })();
  return {
    stream,
    push(line: string) {
      chunks.push(enc.encode(line));
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
  };
}

async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: timed out");
}

describe("session/cancel during a streaming turn (driven through pumpStdin)", () => {
  it("aborts the in-flight turn instead of waiting for it to finish naturally", async () => {
    const out: {
      id?: number;
      method?: string;
      result?: { sessionId?: string; stopReason?: string };
    }[] = [];
    const transport = new AcpTransport({ write: (line) => out.push(JSON.parse(line)) });
    const providers = new ProviderRegistry();
    providers.register("lm", new HangProvider());
    const tools = new ToolRegistry();
    const runtime = new AgentRuntime({
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
    registerSessionMethods(transport, {
      runtime,
      log,
      sessions: new AcpSessions(),
      permissionRouter: { current: async () => "deny" as const },
    });

    const { stream, push, close } = pushableStream();
    const pump = pumpStdin(transport, stream); // run the real read loop in the background

    push(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: dir } })}\n`,
    );
    const created = await waitFor(() => out.find((m) => m.id === 1));
    const sessionId = created.result?.sessionId;
    expect(typeof sessionId).toBe("string");

    // Start a turn that hangs until aborted...
    push(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hi" }] } })}\n`,
    );
    // ...let it register its AbortController, then cancel mid-turn (a notification, no id).
    await new Promise((r) => setTimeout(r, 20));
    push(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })}\n`,
    );

    // With the bug, pumpStdin is parked on `await handleLine(promptLine)` and never reads the
    // cancel, so the prompt response never arrives and this times out. With the fix it cancels.
    const promptResult = await waitFor(() => out.find((m) => m.id === 2));
    expect(promptResult.result?.stopReason).toBe("cancelled");

    close();
    await pump;
  });
});
