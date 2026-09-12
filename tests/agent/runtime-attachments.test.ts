import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Message, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAQB5xW1xAAAAAElFTkSuQmCC",
  "base64",
);

class CapturingProvider implements Provider {
  seen: Message[] = [];
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen = opts.messages;
    yield { type: "text-delta", text: "ok" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

test("runTurn attaches images to the user message it pushes to history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-att-"));
  const path = join(dir, "a.png");
  writeFileSync(path, PNG);
  const provider = new CapturingProvider();
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  const runtime = new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log: new EventLog(":memory:"),
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 2,
  });
  await runtime.runTurn("S", "what is this?", undefined, undefined, undefined, [
    { mime: "image/png", path, sha256: "abc" },
  ]);
  const user = provider.seen.find((m) => m.role === "user");
  expect(user?.images?.[0]?.path).toBe(path);
});
