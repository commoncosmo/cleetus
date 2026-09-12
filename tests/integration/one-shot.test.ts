import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { SessionStore } from "../../src/agent/session";
import { EventLog } from "../../src/events/log";
import { LMStudioProvider } from "../../src/providers/lmstudio";
import { ProviderRegistry } from "../../src/providers/registry";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ReadFileTool } from "../../src/tools/read-file";
import { ToolRegistry } from "../../src/tools/registry";
import { runOneShot } from "../../src/ui/cli/one-shot";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-int-"));
  let turn = 0;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "x" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/v1/chat/completions") {
        turn++;
        let body: string;
        if (turn === 1) {
          body = `${[
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: `{"path":"${join(dir, "f.txt")}"}` } }] } }] })}`,
            `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls" }] })}`,
            "data: [DONE]",
          ].join("\n\n")}\n\n`;
        } else {
          body = `${[
            `data: ${JSON.stringify({ choices: [{ delta: { content: "the file said: hi" } }] })}`,
            `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`,
            "data: [DONE]",
          ].join("\n\n")}\n\n`;
        }
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
  await writeFile(join(dir, "f.txt"), "hi");
});

afterEach(async () => {
  server.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("integration: one-shot with tool use", () => {
  it("calls tool then completes with text answer", async () => {
    const providers = new ProviderRegistry();
    providers.register("lm", new LMStudioProvider({ baseUrl }));
    const tools = new ToolRegistry();
    tools.register(new ReadFileTool());
    const log = new EventLog(join(dir, "events.db"));
    const db = new Database(join(dir, "sessions.db"));
    const sessions = new SessionStore(db);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "x" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 10,
    });
    let out = "";
    const code = await runOneShot({
      runtime,
      log,
      sessions,
      provider: "lm",
      model: "x",
      prompt: "read it",
      write: (c) => {
        out += c;
      },
    });
    expect(code).toBe(0);
    expect(out).toContain("the file said: hi");
    expect(out).toContain("[tool: read_file]");
    log.close();
    db.close();
  });
});
