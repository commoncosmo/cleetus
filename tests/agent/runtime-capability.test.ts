import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMALL_TOOL_ROSTER } from "../../src/agent/capability";
import type { Router } from "../../src/agent/router";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime, type AgentRuntimeOptions } from "../../src/agent/runtime";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent, WindowInfo } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

class RecordingProvider implements Provider {
  requests: ChatOptions[] = [];
  /** Queue of scripted turns; each entry is the events to yield for one chat() call. */
  script: StreamEvent[][] = [];
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncIterable<StreamEvent> {
    this.requests.push(opts);
    const events = this.script.shift() ?? [{ type: "finish", reason: "stop" } as StreamEvent];
    for (const ev of events) yield ev;
  }
  async embed() {
    return [0];
  }
}

function fakeTool(name: string, onRun?: () => void): Tool {
  return {
    name,
    description: `fake ${name}`,
    mutates: false,
    parameters: { type: "object", properties: {} },
    serialize: () => name,
    run: async (): Promise<ToolResult> => {
      onRun?.();
      return { ok: true, output: "ran" };
    },
  };
}

let dir: string;
let db: Database;
let log: EventLog;
let providers: ProviderRegistry;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-cap-rt-"));
  log = new EventLog(join(dir, "events.db"));
  db = new Database(join(dir, "sessions.db"));
  providers = new ProviderRegistry();
});
afterEach(async () => {
  log.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  provider: RecordingProvider,
  toolNames: string[],
  overrides: Partial<AgentRuntimeOptions>,
  onRun?: (name: string) => void,
) {
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  for (const n of toolNames) tools.register(fakeTool(n, () => onRun?.(n)));
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "small-m" }),
    systemPrompt: () => "FULL PROMPT",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 5,
    ...overrides,
  });
}

describe("capability surface (runtime)", () => {
  it("places a hidden active-voice reminder near the live user turn without leaking it to transcript", async () => {
    const p = new RecordingProvider();
    p.script.push([
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop" },
    ]);
    const rt = makeRuntime(p, ["read_file"], {
      voiceReminder: () =>
        "<system-reminder>Active voice: Cleetus. Keep the final prose folksy.</system-reminder>",
    });

    await rt.runTurn("s1", "Tell me the result");

    const liveUser = [...p.requests[0]!.messages]
      .reverse()
      .find((message) => message.role === "user");
    expect(liveUser?.content).toContain("Active voice: Cleetus");
    const transcript = log.query("s1").find((event) => event.type === "user_input")?.payload as {
      text?: string;
    };
    expect(transcript.text).toBe("Tell me the result");
  });

  it("adds web tools to a small retrieval turn without exposing unrelated tools", async () => {
    const p = new RecordingProvider();
    p.script.push([
      { type: "text-delta", text: "forecast" },
      { type: "finish", reason: "stop" },
    ]);
    const rt = makeRuntime(p, ["web_search", "web_fetch", "code_search", "edit_file"], {
      capability: () => "small",
      smallSystemPrompt: () => "SMALL PROMPT",
    });

    await rt.runTurn("s1", "Look up the current weather forecast for Wilmette");

    expect(p.requests[0]!.tools!.map((tool) => tool.name).sort()).toEqual([
      "edit_file",
      "web_fetch",
      "web_search",
    ]);
  });

  it("auto + tiny window serves the small prompt and filtered schemas", async () => {
    const p = new RecordingProvider();
    const rt = makeRuntime(p, ["edit_file", "apply_patch", "mcp__srv__thing"], {
      capability: () => "auto",
      modelContextLength: () => 8192,
      smallSystemPrompt: () => "SMALL PROMPT",
    });
    await rt.runTurn("s1", "hello");
    const req = p.requests[0]!;
    expect(req.messages[0]!.content).toBe("SMALL PROMPT");
    expect(req.tools!.map((t) => t.name).sort()).toEqual(["edit_file", "mcp__srv__thing"]);
  });

  it("unknown window serves small provisionally, then latches standard once the window is known, and holds once latched", async () => {
    const p = new RecordingProvider();
    const state: { window: number | undefined } = { window: undefined };
    const rt = makeRuntime(p, ["edit_file", "apply_patch"], {
      capability: () => "auto",
      modelContextLength: () => state.window,
      smallSystemPrompt: () => "SMALL PROMPT",
    });

    // Turn 1: window unknown → provisional small, NOT latched. (`.at(-1)`, not a fixed index:
    // a "stop" finish with no text-delta triggers the runtime's own empty-turn retry, so a turn
    // may issue more than one provider call — the LAST call is what the turn actually served.)
    await rt.runTurn("s1", "first");
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("SMALL PROMPT");
    expect(p.requests.at(-1)!.tools!.map((t) => t.name)).toEqual(["edit_file"]);

    // Turn 2: window becomes known and large → latches standard, upgrade notice fires.
    state.window = 131072;
    await rt.runTurn("s1", "second");
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("FULL PROMPT");
    expect(
      p.requests
        .at(-1)!
        .tools!.map((t) => t.name)
        .sort(),
    ).toEqual(["apply_patch", "edit_file"]);

    // Turn 3: window goes back to unknown → the turn-2 latch holds regardless.
    state.window = undefined;
    await rt.runTurn("s1", "third");
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("FULL PROMPT");
    expect(
      p.requests
        .at(-1)!
        .tools!.map((t) => t.name)
        .sort(),
    ).toEqual(["apply_patch", "edit_file"]);

    const notices = log
      .query("s1")
      .filter((e) => e.type === "notice")
      .map((e) => (e.payload as { text: string }).text)
      .filter((t) => t.startsWith("capability:"));
    expect(notices).toEqual([
      "capability: small surface for small-m (context window unknown — will upgrade if a larger window is detected)",
      "capability: standard surface for small-m (context window detected)",
    ]);
  });

  it("a known small window latches small on turn 1 and never flips once the window grows", async () => {
    const p = new RecordingProvider();
    const state: { window: number | undefined } = { window: 8192 };
    const rt = makeRuntime(p, ["edit_file", "apply_patch"], {
      capability: () => "auto",
      modelContextLength: () => state.window,
      smallSystemPrompt: () => "SMALL PROMPT",
    });
    await rt.runTurn("s1", "first"); // known small window → latches small immediately
    state.window = 131072;
    await rt.runTurn("s1", "second"); // latched on real evidence must NOT flip
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("SMALL PROMPT");
    expect(p.requests.at(-1)!.tools!.map((t) => t.name)).toEqual(["edit_file"]);

    const notices = log
      .query("s1")
      .filter((e) => e.type === "notice")
      .map((e) => (e.payload as { text: string }).text)
      .filter((t) => t.startsWith("capability:"));
    expect(notices).toEqual([
      "capability: small surface for small-m (12 tools, distilled prompt) — set capability: standard to override",
    ]);
  });

  it("the unknown-window provisional notice fires once per model, not once per turn", async () => {
    const p = new RecordingProvider();
    const rt = makeRuntime(p, ["edit_file"], {
      capability: () => "auto",
      modelContextLength: () => undefined,
    });
    await rt.runTurn("s1", "first");
    await rt.runTurn("s1", "second");
    const notices = log
      .query("s1")
      .filter((e) => e.type === "notice")
      .map((e) => (e.payload as { text: string }).text)
      .filter((t) => t.startsWith("capability:"));
    expect(notices).toEqual([
      "capability: small surface for small-m (context window unknown — will upgrade if a larger window is detected)",
    ]);
  });

  it("explicit standard config bypasses auto-detection entirely", async () => {
    const p = new RecordingProvider();
    const rt = makeRuntime(p, ["edit_file", "apply_patch"], {
      capability: () => "standard",
      modelContextLength: () => 4096,
      smallSystemPrompt: () => "SMALL PROMPT",
    });
    await rt.runTurn("s1", "hello");
    expect(p.requests[0]!.messages[0]!.content).toBe("FULL PROMPT");
    expect(p.requests[0]!.tools!.map((t) => t.name).sort()).toEqual(["apply_patch", "edit_file"]);
  });

  it("omitted capability option behaves as standard (back-compat)", async () => {
    const p = new RecordingProvider();
    const rt = makeRuntime(p, ["edit_file", "apply_patch"], {
      modelContextLength: () => 4096,
    });
    await rt.runTurn("s1", "hello");
    expect(p.requests[0]!.tools!.map((t) => t.name).sort()).toEqual(["apply_patch", "edit_file"]);
  });

  it("a hidden-tool call is redirected before the permission prompt", async () => {
    const p = new RecordingProvider();
    p.script = [
      [
        { type: "tool-call", call: { id: "c1", name: "apply_patch", args: {} } },
        { type: "finish", reason: "tool-calls" },
      ],
      [{ type: "finish", reason: "stop" }],
    ];
    const ran: string[] = [];
    let permissionAsked = 0;
    const rt = makeRuntime(
      p,
      ["edit_file", "apply_patch"],
      {
        capability: () => "small",
        resolvePermission: async () => {
          permissionAsked++;
          return "allow";
        },
      },
      (n) => ran.push(n),
    );
    await rt.runTurn("s1", "patch something");
    expect(ran).toEqual([]); // hidden tool never executed
    expect(permissionAsked).toBe(0); // rejected before the permission prompt
    const toolMsg = p.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg!.content).toContain(
      "apply_patch is not available in this session; use edit_file.",
    );
  });

  it("an unknown-tool call at small capability only advertises the roster (+ mcp__) tools", async () => {
    const p = new RecordingProvider();
    p.script = [
      [
        { type: "tool-call", call: { id: "c1", name: "str_replace_editor", args: {} } },
        { type: "finish", reason: "tool-calls" },
      ],
      [{ type: "finish", reason: "stop" }],
    ];
    const rt = makeRuntime(p, ["edit_file", "apply_patch", "git_status", "mcp__srv__thing"], {
      capability: () => "small",
    });
    await rt.runTurn("s1", "do a thing");
    const toolMsg = p.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg!.content).toContain("no tool named 'str_replace_editor'. Available tools:");
    const listed = toolMsg!.content.split("Available tools: ")[1]!.split(", ").sort();
    expect(listed).toEqual(["edit_file", "mcp__srv__thing"]);
    expect(listed).not.toContain("apply_patch");
    expect(listed).not.toContain("git_status");
  });

  it("emits the one-time small-latch notice in auto mode only", async () => {
    const p = new RecordingProvider();
    const rt = makeRuntime(p, ["edit_file"], {
      capability: () => "auto",
      modelContextLength: () => 4096,
    });
    await rt.runTurn("s1", "one");
    await rt.runTurn("s1", "two");
    const notices = log
      .query("s1")
      .filter((e) => e.type === "notice")
      .map((e) => (e.payload as { text: string }).text)
      .filter((t) => t.startsWith("capability:"));
    expect(notices).toEqual([
      "capability: small surface for small-m (12 tools, distilled prompt) — set capability: standard to override",
    ]);
  });

  it("small capability suppresses the version-pin reminder; standard includes it", async () => {
    const small = new RecordingProvider();
    const rtSmall = makeRuntime(small, [], { capability: () => "small" });
    await rtSmall.runTurn("s1", "build a Tauri v2 desktop app");
    const smallUserMsg = small.requests[0]!.messages.filter((m) => m.role === "user").pop()!;
    expect(smallUserMsg.content).not.toContain("<system-reminder>");

    const standard = new RecordingProvider();
    const rtStandard = makeRuntime(standard, [], { capability: () => "standard" });
    await rtStandard.runTurn("s2", "build a Tauri v2 desktop app");
    const standardUserMsg = standard.requests[0]!.messages.filter((m) => m.role === "user").pop()!;
    expect(standardUserMsg.content).toContain("<system-reminder>");
  });

  it("the auto-capability route preview sees what loop 0 actually serves, even with a content-sensitive router", async () => {
    // A router whose choice depends on the *content* of the last user message (like the real
    // smart router's char-count/keyword rules). If the preview used a different last-message
    // content than loop 0's real router.select call, the two would disagree on the model.
    const contentSensitiveRouter: Router = {
      select: (ctx) => {
        const last = ctx.messages[ctx.messages.length - 1];
        const model = last?.content.includes("<system-reminder>") ? "large-m" : "small-m";
        return { choice: { provider: "lm", model }, tier: null, reason: "content-sensitive" };
      },
      finishPass: () => null,
    };
    const p = new RecordingProvider();
    const rt = makeRuntime(p, [], {
      router: contentSensitiveRouter,
      capability: () => "auto",
      modelContextLength: () => 4096, // → "small" cap regardless of which model latches
      // Sticky-skill injection, wired to add a <system-reminder> block — the very fragment
      // the route preview must (post-fix) see, and did not (pre-fix).
      triggeredSkillReminders: () => ["<system-reminder>do the thing</system-reminder>"],
    });
    await rt.runTurn("s1", "hello");

    const req = p.requests[0]!;
    const notice = log
      .query("s1")
      .find(
        (e) =>
          e.type === "notice" && (e.payload as { text: string }).text.startsWith("capability:"),
      );
    expect(notice).toBeDefined();
    const previewedModel = (notice!.payload as { text: string }).text.match(/for (\S+) \(/)?.[1];

    // The model named in the capability-latch notice is the model the route PREVIEW picked.
    // It must match the model the provider actually received on loop 0 — otherwise the
    // surface/prompt (and this notice) get pinned to a model different from the one really
    // serving the turn.
    expect(previewedModel).toBe(req.model);
    expect(req.model).toBe("large-m");
  });

  it("auto latch reads the PREVIEWED model's window, not the active model's", async () => {
    // Router preview (turnIndex 0) selects "small-m" (the default makeRuntime router); the
    // closure below returns 65536 for every model EXCEPT "small-m", which mimics the old bug's
    // nullary call always landing on the "active model" branch. Post-fix, the previewed model
    // ("small-m") is threaded through, so the 8192 branch is hit and the latch is "small".
    const p = new RecordingProvider();
    const rt = makeRuntime(p, [...SMALL_TOOL_ROSTER, "apply_patch", "git_status"], {
      capability: () => "auto",
      modelContextLength: (m?: string) => (m === "small-m" ? 8192 : 65536),
    });
    await rt.runTurn("s1", "hello");

    const req = p.requests.at(-1)!;
    expect(req.tools!.map((t) => t.name).sort()).toEqual([...SMALL_TOOL_ROSTER].sort());

    const notices = log
      .query("s1")
      .filter((e) => e.type === "notice")
      .map((e) => (e.payload as { text: string }).text)
      .filter((t) => t.startsWith("capability:"));
    expect(notices).toEqual([
      `capability: small surface for small-m (${SMALL_TOOL_ROSTER.size} tools, distilled prompt) — set capability: standard to override`,
    ]);
  });

  it("previewed model with no cached window stays provisional (no latch)", async () => {
    const p = new RecordingProvider();
    const rt = makeRuntime(p, ["edit_file"], {
      router: staticRouter({ provider: "lm", model: "cold-m" }),
      capability: () => "auto",
      modelContextLength: (m?: string) => (m === "warm-m" ? 32768 : undefined),
    });
    await rt.runTurn("s1", "hello");

    expect(p.requests.at(-1)!.tools!.map((t) => t.name)).toEqual(["edit_file"]);
    const notices = log
      .query("s1")
      .filter((e) => e.type === "notice")
      .map((e) => (e.payload as { text: string }).text)
      .filter((t) => t.startsWith("capability:"));
    expect(notices).toEqual([
      "capability: small surface for cold-m (context window unknown — will upgrade if a larger window is detected)",
    ]);
  });

  it("explicit capability: small emits no notice", async () => {
    const p = new RecordingProvider();
    const rt = makeRuntime(p, ["edit_file"], {
      capability: () => "small",
    });
    await rt.runTurn("s1", "hello");

    const notices = log
      .query("s1")
      .filter((e) => e.type === "notice")
      .map((e) => (e.payload as { text: string }).text)
      .filter((t) => t.startsWith("capability:"));
    expect(notices).toEqual([]);
  });

  it("preview on a DIFFERENT provider latches from that provider's window", async () => {
    // Router preview selects { provider: "other", model: "big-m" } while the active pair would
    // be ("main", "act-m") in a real session. The closure below returns 65536 ONLY for
    // ("other", "big-m") and 8192 for everything else — the shape the old (provider-blind)
    // lookup would hit if it silently substituted the active provider. Post-fix, the previewed
    // provider is threaded through, so the 65536 branch is hit and the latch is "standard".
    const p = new RecordingProvider();
    providers.register("other", p);
    const rt = makeRuntime(p, ["edit_file", "apply_patch"], {
      router: staticRouter({ provider: "other", model: "big-m" }),
      capability: () => "auto",
      modelContextLength: (m?: string, pr?: string) =>
        pr === "other" && m === "big-m" ? 65536 : 8192,
    });
    await rt.runTurn("s1", "hello");

    const req = p.requests.at(-1)!;
    expect(req.tools!.map((t) => t.name).sort()).toEqual(["apply_patch", "edit_file"]);

    const notices = log
      .query("s1")
      .filter((e) => e.type === "notice")
      .map((e) => (e.payload as { text: string }).text)
      .filter((t) => t.startsWith("capability:"));
    expect(notices).toEqual([]); // standard on turn 1: no small notice, no provisional notice
  });

  it("same model id on two providers latches independently", async () => {
    // Same model id ("qwen3:8b") served by two different providers must latch separately: a
    // model-only key would have turn 2 short-circuit on turn 1's "small" latch and never see
    // the large window. modelContextLength reports 8192 for "ollama" and 65536 for anything else.
    const p = new RecordingProvider();
    providers.register("ollama", p);
    const state: { provider: string } = { provider: "ollama" };
    const router: Router = {
      select: () => ({
        choice: { provider: state.provider, model: "qwen3:8b" },
        tier: null,
        reason: "test",
      }),
      finishPass: () => null,
    };
    const rt = makeRuntime(p, ["edit_file", "apply_patch"], {
      router,
      capability: () => "auto",
      modelContextLength: (_m?: string, pr?: string) => (pr === "ollama" ? 8192 : 65536),
      smallSystemPrompt: () => "SMALL PROMPT",
    });

    await rt.runTurn("s1", "first"); // provider "ollama" → small window → latches small
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("SMALL PROMPT");
    expect(p.requests.at(-1)!.tools!.map((t) => t.name)).toEqual(["edit_file"]);

    state.provider = "lm"; // same model id, different provider → independent key
    await rt.runTurn("s1", "second"); // provider "lm" → large window → latches standard
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("FULL PROMPT");
    expect(
      p.requests
        .at(-1)!
        .tools!.map((t) => t.name)
        .sort(),
    ).toEqual(["apply_patch", "edit_file"]);
  });
});

describe("capability surface — source-aware latch (modelContextInfo)", () => {
  it("architectural window grants standard provisionally; a later loaded small window downgrades", async () => {
    const p = new RecordingProvider();
    const state: { info: WindowInfo | undefined } = { info: undefined };
    const rt = makeRuntime(p, ["edit_file", "apply_patch"], {
      capability: () => "auto",
      smallSystemPrompt: () => "SMALL PROMPT",
      modelContextInfo: () => state.info,
    });

    await rt.runTurn("s1", "t1"); // unknown → provisional small
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("SMALL PROMPT");

    state.info = { window: 131072, source: "architectural" };
    await rt.runTurn("s1", "t2"); // architectural → standard, NOT latched
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("FULL PROMPT");
    expect(
      p.requests
        .at(-1)!
        .tools!.map((t) => t.name)
        .sort(),
    ).toEqual(["apply_patch", "edit_file"]);

    state.info = { window: 8192, source: "loaded" }; // authoritative small
    await rt.runTurn("s1", "t3"); // loaded small → latches small
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("SMALL PROMPT");

    state.info = { window: 131072, source: "architectural" };
    await rt.runTurn("s1", "t4"); // latched small holds regardless
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("SMALL PROMPT");
  });

  it("architectural window below threshold serves small, stays quiet, and does not latch", async () => {
    const p = new RecordingProvider();
    const state: { info: WindowInfo | undefined } = { info: undefined };
    const rt = makeRuntime(p, ["edit_file", "apply_patch"], {
      capability: () => "auto",
      smallSystemPrompt: () => "SMALL PROMPT",
      modelContextInfo: () => state.info,
    });

    state.info = { window: 4096, source: "architectural" };
    await rt.runTurn("s1", "t1"); // architectural small → small surface, no notice
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("SMALL PROMPT");

    const notices = log
      .query("s1")
      .filter((e) => e.type === "notice")
      .map((e) => (e.payload as { text: string }).text)
      .filter((t) => t.startsWith("capability:"));
    expect(notices).toEqual([]);

    state.info = { window: 131072, source: "architectural" };
    await rt.runTurn("s1", "t2"); // architectural small did NOT latch → standard now serves
    expect(p.requests.at(-1)!.messages[0]!.content).toBe("FULL PROMPT");
  });

  it("cloud model: architectural window serves standard every turn and never latches", async () => {
    const p = new RecordingProvider();
    const rt = makeRuntime(p, ["edit_file", "apply_patch"], {
      capability: () => "auto",
      smallSystemPrompt: () => "SMALL PROMPT",
      modelContextInfo: () => ({ window: 1_000_000, source: "architectural" }),
    });
    await rt.runTurn("s1", "t1");
    await rt.runTurn("s1", "t2");
    expect(p.requests.every((r) => r.messages[0]!.content === "FULL PROMPT")).toBe(true);
  });

  it("emits the standard-surface notice exactly once across the provisional→architectural transition", async () => {
    const p = new RecordingProvider();
    const state: { info: WindowInfo | undefined } = { info: undefined };
    const rt = makeRuntime(p, [], {
      capability: () => "auto",
      modelContextInfo: () => state.info,
    });
    await rt.runTurn("s1", "t1"); // provisional small notice
    state.info = { window: 1_000_000, source: "architectural" };
    await rt.runTurn("s1", "t2"); // standard detected notice (once)
    await rt.runTurn("s1", "t3"); // still architectural → NO repeat notice
    const notices = log
      .query("s1")
      .filter((e) => e.type === "notice")
      .map((e) => (e.payload as { text: string }).text)
      .filter((t) => t.startsWith("capability:"));
    expect(notices).toEqual([
      "capability: small surface for small-m (context window unknown — will upgrade if a larger window is detected)",
      "capability: standard surface for small-m (context window detected)",
    ]);
  });
});
