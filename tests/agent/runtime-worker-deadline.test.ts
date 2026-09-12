import { expect, test } from "bun:test";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime, turnDeadlineMs } from "../../src/agent/runtime";
import type { EventInput } from "../../src/events/types";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool } from "../../src/tools/types";

class HangingProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(req: { signal?: AbortSignal }): AsyncIterable<StreamEvent> {
    // Mirror real signal semantics (e.g. fetch): a signal already aborted before the call
    // starts must reject immediately — an "abort" listener added afterward never fires.
    if (req.signal?.aborted) throw new DOMException("aborted", "AbortError");
    await new Promise<void>((_resolve, reject) => {
      req.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

function opts(workerTurnMs: number) {
  const providers = new ProviderRegistry();
  providers.register("lm", new HangingProvider());
  const tools = new ToolRegistry();
  return {
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log: { append: (e: EventInput) => ({ ...e, id: "x", ts: 0 }) },
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "P",
    projectDir: "/tmp",
    resolvePermission: async () => "allow" as const,
    maxToolLoops: 5,
    workerTurnMs,
  };
}

test("turnDeadlineMs gates on the orchestration-worker source", () => {
  expect(turnDeadlineMs("orchestration-worker", 750000)).toBe(750000);
  expect(turnDeadlineMs("orchestration-worker", 0)).toBe(0);
  expect(turnDeadlineMs("orchestration-worker", undefined)).toBe(0);
  expect(turnDeadlineMs("interactive", 750000)).toBe(0); // interactive turns unaffected
});

test("a worker turn exceeding worker_turn_ms stops with time_budget", async () => {
  const rt = new AgentRuntime(opts(40));
  const res = await rt.runTurn(
    "s1",
    "do it",
    new AbortController().signal,
    "orchestration-worker",
    "T",
  );
  expect(res.stoppedReason).toBe("time_budget");
});

test("a user abort is NOT reported as time_budget", async () => {
  const rt = new AgentRuntime(opts(0)); // deadline disabled
  const ac = new AbortController();
  const p = rt.runTurn("s1", "do it", ac.signal, "orchestration-worker", "T");
  ac.abort();
  const res = await p;
  expect(res.stoppedReason).not.toBe("time_budget");
});

test("permission wait time does not consume the worker deadline", async () => {
  let calls = 0;
  const provider: Provider = {
    async listModels() {
      return [{ id: "m" }];
    },
    async *chat(): AsyncIterable<StreamEvent> {
      calls++;
      if (calls === 1) {
        yield { type: "tool-call", call: { id: "c1", name: "probe", args: {} } };
        yield { type: "finish", reason: "tool-calls" };
        return;
      }
      yield { type: "text-delta", text: "completed after approval" };
      yield { type: "finish", reason: "stop" };
    },
    async embed() {
      return [0];
    },
  };
  const probe: Tool = {
    name: "probe",
    description: "probe",
    parameters: { type: "object", properties: {} },
    serialize: () => "probe",
    run: async () => ({ ok: true, output: "ok" }),
  };
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(probe);
  const rt = new AgentRuntime({
    ...opts(40),
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    resolvePermission: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "allow" as const;
    },
  });

  const res = await rt.runTurn(
    "s1",
    "use the probe",
    new AbortController().signal,
    "orchestration-worker",
    "T",
  );

  expect(res.stoppedReason).toBeUndefined();
  expect(res.assistantText).toBe("completed after approval");
});
