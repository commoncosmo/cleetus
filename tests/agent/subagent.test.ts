import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import type { AgentRuntimeOptions } from "../../src/agent/runtime";
import { buildSubagentSpawner, subagentSystemPrompt } from "../../src/agent/subagent";
import type { CheckpointRecorder } from "../../src/checkpoint/types";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { TodoItem, Tool, ToolResult } from "../../src/tools/types";

class ScriptedProvider implements Provider {
  calls: ChatOptions[] = [];
  constructor(private script: StreamEvent[][]) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions) {
    this.calls.push(opts);
    const turn = this.script.shift();
    if (!turn) throw new Error("script empty");
    for (const e of turn) yield e;
  }
  async embed() {
    return [0];
  }
}

/** A write tool that reports a diff so the runtime calls recordFile. */
class FakeWriteTool implements Tool {
  name = "fake_write";
  description = "writes";
  mutates = true;
  parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  serialize(args: unknown) {
    return `fake_write ${(args as { path: string }).path}`;
  }
  async run(args: unknown): Promise<ToolResult> {
    const path = (args as { path: string }).path;
    return { ok: true, output: `wrote ${path}`, diff: { path, before: "old", after: "new" } };
  }
}

/** Records what the parent recorder is asked to do. */
class RecordingRecorder implements CheckpointRecorder {
  begins = 0;
  files: string[] = [];
  begin(_s: string, _u: string, _h: number, _t?: TodoItem[]): void {
    this.begins++;
  }
  recordFile(path: string): void {
    this.files.push(path);
  }
}

let dir: string;
let log: EventLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-sub-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function parentOpts(provider: Provider, recorder?: CheckpointRecorder): AgentRuntimeOptions {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(new FakeWriteTool());
  return {
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "PARENT-PROMPT",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 10,
    checkpoints: recorder,
  };
}

describe("subagentSystemPrompt", () => {
  test("prepends a role preamble onto the base prompt", () => {
    const explore = subagentSystemPrompt("explore", "BASE");
    expect(explore).toContain("BASE");
    expect(explore.toLowerCase()).toContain("read-only");
    expect(subagentSystemPrompt("general", "BASE")).toContain("BASE");
  });

  test("voiced=true appends a recency voice directive; default omits it (byte-identical)", () => {
    // #119: workers already carry the overlay in `base`, but the terse-reporter preamble buries it.
    // A trailing nudge (only when a voice is active) makes worker-visible output speak in-voice.
    const plain = subagentSystemPrompt("general", "BASE");
    const voiced = subagentSystemPrompt("general", "BASE", true);
    expect(subagentSystemPrompt("general", "BASE", false)).toBe(plain); // default === voiced:false
    expect(voiced).not.toBe(plain);
    expect(voiced.startsWith(plain)).toBe(true); // directive is appended; base untouched
    expect(voiced.toUpperCase()).toContain("VOICE");
    expect(voiced.toLowerCase()).toContain("in-character");
  });
});

describe("buildSubagentSpawner", () => {
  test("runs a general sub-agent that edits, returns its summary, and forwards recordFile", async () => {
    const recorder = new RecordingRecorder();
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", call: { id: "1", name: "fake_write", args: { path: "a.ts" } } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "edited a.ts" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const spawn = buildSubagentSpawner(parentOpts(provider, recorder));
    const result = await spawn({
      type: "general",
      prompt: "edit a.ts",
      signal: new AbortController().signal,
    });
    expect(result.assistantText).toBe("edited a.ts");
    // Sub-edit forwarded to the PARENT recorder...
    expect(recorder.files).toContain("a.ts");
    // ...but the sub-run never opened its own checkpoint (begin is a no-op wrapper).
    expect(recorder.begins).toBe(0);
  });

  test("an explore sub-agent does not receive mutating tools", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", call: { id: "1", name: "fake_write", args: { path: "a.ts" } } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "could not write" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const recorder = new RecordingRecorder();
    const spawn = buildSubagentSpawner(parentOpts(provider, recorder));
    const result = await spawn({
      type: "explore",
      prompt: "investigate",
      signal: new AbortController().signal,
    });
    expect(result.assistantText).toBe("could not write");
    // The write never reached the parent recorder because the tool wasn't available.
    expect(recorder.files).toEqual([]);
  });

  test("wraps a parent smallSystemPrompt with the same subagent framing as the standard prompt", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text-delta", text: "done" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const opts = parentOpts(provider);
    const spawn = buildSubagentSpawner({
      ...opts,
      capability: () => "small",
      smallSystemPrompt: () => "SMALL PROMPT",
    });
    const result = await spawn({
      type: "general",
      prompt: "do a thing",
      signal: new AbortController().signal,
    });
    expect(result.assistantText).toBe("done");
    const sys = provider.calls[0]!.messages.find((m) => m.role === "system")!;
    expect(sys.content).toContain(subagentSystemPrompt("general", "SMALL PROMPT"));
  });
});
