import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../../src/agent/router";
import { AgentRuntime } from "../../../src/agent/runtime";
import { SessionStore } from "../../../src/agent/session";
import { EventLog } from "../../../src/events/log";
import { ProviderRegistry } from "../../../src/providers/registry";
import type { Provider, StreamEvent } from "../../../src/providers/types";
import { ToolDispatcher } from "../../../src/tools/dispatcher";
import { ToolRegistry } from "../../../src/tools/registry";
import { runOneShot } from "../../../src/ui/cli/one-shot";

class FakeProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(): AsyncIterable<StreamEvent> {
    yield { type: "text-delta", text: "hi from " };
    yield { type: "text-delta", text: "the model" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-oneshot-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runOneShot", () => {
  it("streams text to provided writer and returns exit code 0", async () => {
    const log = new EventLog(join(dir, "events.db"));
    const db = new Database(join(dir, "sessions.db"));
    const sessions = new SessionStore(db);
    const providers = new ProviderRegistry();
    providers.register("p", new FakeProvider());
    const tools = new ToolRegistry();
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "p", model: "m" }),
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
      provider: "p",
      model: "m",
      prompt: "hello",
      write: (chunk) => {
        out += chunk;
      },
    });
    expect(code).toBe(0);
    expect(out).toContain("hi from the model");
    log.close();
    db.close();
  });

  it("prints warning and explicitly verbose notices only when --verbose is active", async () => {
    const log = new EventLog(join(dir, "events.db"));
    const db = new Database(join(dir, "sessions.db"));
    const sessions = new SessionStore(db);
    const runtime = {
      async runTurn(sessionId: string) {
        log.append({
          sessionId,
          type: "notice",
          payload: {
            text: "discarded internal correction",
            visibility: "verbose",
          },
        });
        log.append({
          sessionId,
          type: "notice",
          payload: {
            text: "bounded finish pass reached its output ceiling",
            level: "warn",
          },
        });
      },
    } as unknown as AgentRuntime;

    const run = async (verbose: boolean) => {
      let output = "";
      await runOneShot({
        runtime,
        log,
        sessions,
        provider: "p",
        model: "m",
        prompt: "hello",
        write: (chunk) => {
          output += chunk;
        },
        verbose,
      });
      return output;
    };

    expect(await run(false)).not.toContain("discarded internal correction");
    expect(await run(false)).not.toContain("bounded finish pass reached its output ceiling");
    const verboseOutput = await run(true);
    expect(verboseOutput).toContain("discarded internal correction");
    expect(verboseOutput).toContain("bounded finish pass reached its output ceiling");
    log.close();
    db.close();
  });
});
