import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, StreamEvent } from "../../src/providers/types";
import type { VisionSupport } from "../../src/providers/vision";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

/** A provider whose vision verdict is configurable; omit `verdict` to leave `supportsVision`
 *  undefined (the "provider can't say" case → runtime must report "unknown"). */
class ProbeProvider implements Provider {
  supportsVision?: (model: string) => Promise<VisionSupport>;
  constructor(verdict?: VisionSupport) {
    if (verdict) this.supportsVision = async () => verdict;
  }
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(): AsyncGenerator<StreamEvent> {
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-vis-"));
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
    router: staticRouter({ provider: "lm", model: "vm" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "deny",
    maxToolLoops: 4,
  });
}

describe("AgentRuntime.visionSupportForActiveModel", () => {
  it("reports the provider verdict and the active model name", async () => {
    expect(await makeRuntime(new ProbeProvider("yes")).visionSupportForActiveModel()).toEqual({
      support: "yes",
      model: "vm",
    });
    expect(await makeRuntime(new ProbeProvider("no")).visionSupportForActiveModel()).toEqual({
      support: "no",
      model: "vm",
    });
  });

  it("reports 'unknown' when the provider has no supportsVision", async () => {
    expect(await makeRuntime(new ProbeProvider()).visionSupportForActiveModel()).toEqual({
      support: "unknown",
      model: "vm",
    });
  });
});
