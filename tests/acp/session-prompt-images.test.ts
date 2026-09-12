import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSessions } from "../../src/acp/session";
import { registerSessionMethods } from "../../src/acp/session-methods";
import { AcpTransport } from "../../src/acp/transport";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { DEFAULT_VISION, type VisionConfig } from "../../src/config/vision";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Message, Provider, StreamEvent } from "../../src/providers/types";
import type { VisionSupport } from "../../src/providers/vision";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

// A minimal valid 1x1 PNG (magic bytes pass `sniffImageMime`).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAQB5xW1xAAAAAElFTkSuQmCC";

/** Captures every chat request's messages so the test can inspect the `images` field the
 *  runtime attached to the user message it pushed to history. */
class CapturingProvider implements Provider {
  seen: Message[][] = [];
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.messages);
    yield { type: "text-delta", text: "ok" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-acp-img-"));
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
  id?: number;
  method?: string;
  params?: { sessionId?: string; update?: unknown };
  result?: { sessionId?: string; stopReason?: string } | null;
}

/** Wires session methods with a given vision config so tests can exercise ACP image blocks
 *  end to end and observe what reaches the provider's chat request. */
function wire(provider: Provider, vision: VisionConfig = DEFAULT_VISION) {
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
    vision,
  });
  const send = (id: number, method: string, params: unknown) =>
    transport.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return { out, send, runtime };
}

describe("ACP session/prompt image blocks", () => {
  it("resolves image resource and resource_link blocks into ImageRef[] attached to the turn", async () => {
    const provider = new CapturingProvider();
    const { out, send } = wire(provider);
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((m) => m.id === 1)?.result?.sessionId;

    const path = join(dir, "a.png");
    await Bun.write(path, Buffer.from(PNG_B64, "base64"));

    await send(2, "session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "look at these" },
        { type: "resource", resource: { mimeType: "image/png", blob: PNG_B64 } },
        { type: "resource_link", uri: path, mimeType: "image/png" },
      ],
    });

    expect(out.find((m) => m.id === 2)?.result?.stopReason).toBe("end_turn");
    expect(provider.seen).toHaveLength(1);
    const user = provider.seen[0]!.find((m) => m.role === "user");
    expect(user?.images).toBeDefined();
    expect(user!.images).toHaveLength(2);
    expect(user!.images!.every((ref) => ref.mime === "image/png")).toBe(true);
  });

  it("caps attached images at vision.maxPerTurn across base64 and path candidates combined", async () => {
    const provider = new CapturingProvider();
    const { out, send } = wire(provider, { ...DEFAULT_VISION, maxPerTurn: 2 });
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((m) => m.id === 1)?.result?.sessionId;

    await send(2, "session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "four images, cap is two" },
        { type: "resource", resource: { mimeType: "image/png", blob: PNG_B64 } },
        { type: "resource", resource: { mimeType: "image/png", blob: PNG_B64 } },
        { type: "resource", resource: { mimeType: "image/png", blob: PNG_B64 } },
        { type: "resource", resource: { mimeType: "image/png", blob: PNG_B64 } },
      ],
    });

    expect(out.find((m) => m.id === 2)?.result?.stopReason).toBe("end_turn");
    expect(provider.seen).toHaveLength(1);
    const user = provider.seen[0]!.find((m) => m.role === "user");
    expect(user?.images).toHaveLength(2);
  });

  it("surfaces a dropped image (non-image base64 blob) as a session/update notice", async () => {
    const provider = new CapturingProvider();
    const { out, send } = wire(provider);
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((m) => m.id === 1)?.result?.sessionId;

    await send(2, "session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "look at this" },
        // Not a real image — storeImage's magic-byte sniff rejects it.
        {
          type: "resource",
          resource: { mimeType: "image/png", blob: Buffer.from("not an image").toString("base64") },
        },
      ],
    });

    expect(out.find((m) => m.id === 2)?.result?.stopReason).toBe("end_turn");
    const notices = out.filter(
      (m) =>
        m.method === "session/update" &&
        (m.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate ===
          "agent_message_chunk" &&
        (
          (m.params?.update as { content?: { text?: string } } | undefined)?.content?.text ?? ""
        ).includes("[image]"),
    );
    expect(notices.length).toBeGreaterThan(0);
    expect((notices[0]!.params!.update as { content: { text: string } }).content.text).toContain(
      "not a supported image",
    );

    // The rejected image never reached the provider's user message.
    const user = provider.seen[0]?.find((m) => m.role === "user");
    expect(user?.images ?? []).toHaveLength(0);
  });
});

// --- vision-gate providers (extend the capturing provider with a supportsVision verdict) ---
class BlindProvider extends CapturingProvider {
  probes = 0;
  async supportsVision(): Promise<VisionSupport> {
    this.probes++;
    return "no";
  }
}
class SightedProvider extends CapturingProvider {
  async supportsVision(): Promise<VisionSupport> {
    return "yes";
  }
}
// (unknown verdict = base CapturingProvider — no supportsVision method)

/** Collect the text of every `[image]` agent_message_chunk notice. */
function imageNotices(out: Outbound[]): string[] {
  return out
    .filter(
      (m) =>
        m.method === "session/update" &&
        (m.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate ===
          "agent_message_chunk",
    )
    .map(
      (m) => (m.params?.update as { content?: { text?: string } } | undefined)?.content?.text ?? "",
    )
    .filter((t) => t.includes("[image]"));
}

describe("ACP session/prompt vision gating", () => {
  it("block: notifies, drops the images, and runs the turn text-only", async () => {
    const provider = new BlindProvider();
    const { out, send } = wire(provider);
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((m) => m.id === 1)?.result?.sessionId;

    await send(2, "session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "look" },
        { type: "resource", resource: { mimeType: "image/png", blob: PNG_B64 } },
      ],
    });

    expect(out.find((m) => m.id === 2)?.result?.stopReason).toBe("end_turn");
    expect(imageNotices(out).some((t) => t.includes("can't view images"))).toBe(true);
    // Turn still ran; the blocked image never reached the provider.
    expect(provider.seen).toHaveLength(1);
    const user = provider.seen[0]!.find((m) => m.role === "user");
    expect(user?.images ?? []).toHaveLength(0);
  });

  it("warn (unknown capability): notifies but keeps the images", async () => {
    const provider = new CapturingProvider(); // no supportsVision → "unknown"
    const { out, send } = wire(provider);
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((m) => m.id === 1)?.result?.sessionId;

    await send(2, "session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "look" },
        { type: "resource", resource: { mimeType: "image/png", blob: PNG_B64 } },
      ],
    });

    expect(imageNotices(out).some((t) => t.includes("can't confirm"))).toBe(true);
    const user = provider.seen[0]!.find((m) => m.role === "user");
    expect(user?.images).toHaveLength(1);
  });

  it("send (supported): no gate notice, images kept", async () => {
    const provider = new SightedProvider();
    const { out, send } = wire(provider);
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((m) => m.id === 1)?.result?.sessionId;

    await send(2, "session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "look" },
        { type: "resource", resource: { mimeType: "image/png", blob: PNG_B64 } },
      ],
    });

    const notices = imageNotices(out);
    expect(
      notices.some((t) => t.includes("can't view images") || t.includes("can't confirm")),
    ).toBe(false);
    const user = provider.seen[0]!.find((m) => m.role === "user");
    expect(user?.images).toHaveLength(1);
  });

  it("no images: the vision probe is not run", async () => {
    const provider = new BlindProvider();
    const { out, send } = wire(provider);
    await send(1, "session/new", { cwd: dir });
    const sessionId = out.find((m) => m.id === 1)?.result?.sessionId;

    await send(2, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "no images here" }],
    });

    expect(provider.probes).toBe(0);
  });
});
