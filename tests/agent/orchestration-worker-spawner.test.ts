import { expect, test } from "bun:test";
import { staticRouter } from "../../src/agent/router";
import type { AgentRuntimeOptions } from "../../src/agent/runtime";
import { buildOrchestrationWorkerSpawner } from "../../src/agent/subagent";
import type { EventInput } from "../../src/events/types";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { renderWorkerSeed } from "../../src/skills/orchestration";
import { triggeredSkills } from "../../src/skills/trigger";
import type { Skill } from "../../src/skills/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool } from "../../src/tools/types";

class ScriptedProvider implements Provider {
  constructor(private script: StreamEvent[][]) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat() {
    const turn = this.script.shift();
    if (!turn) throw new Error("script empty");
    for (const e of turn) yield e;
  }
  async embed() {
    return [0];
  }
}

/** A provider that records the system message of the most recent chat() call. */
class CapturingProvider implements Provider {
  lastSystem = "";
  lastUser = "";
  async listModels() {
    return [{ id: "m" }];
  }
  // biome-ignore lint/suspicious/noExplicitAny: test stub only needs messages
  async *chat(req: any): AsyncIterable<StreamEvent> {
    this.lastSystem =
      req.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "";
    this.lastUser =
      req.messages?.filter((m: { role: string }) => m.role === "user").pop()?.content ?? "";
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

class InspectingProvider implements Provider {
  calls = 0;
  sawEditNudge = false;
  constructor(
    private readonly inspectRounds: number,
    private readonly growInput = false,
  ) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(req: ChatOptions): AsyncIterable<StreamEvent> {
    this.calls++;
    this.sawEditNudge ||= JSON.stringify(req.messages).includes(
      "Stop inventorying and make the smallest viable file edit now",
    );
    const input = this.growInput ? this.calls * 100 : 100;
    if (this.calls <= this.inspectRounds) {
      yield {
        type: "tool-call",
        call: { id: `read-${this.calls}`, name: "read_file", args: { path: "src/app.ts" } },
      };
      yield { type: "finish", reason: "tool-calls", usage: { input, output: 0 }, model: "m" };
      return;
    }
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", reason: "stop", usage: { input, output: 0 }, model: "m" };
  }
  async embed() {
    return [0];
  }
}

class ConvergingProvider implements Provider {
  calls = 0;
  toolCounts: number[] = [];
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(req: ChatOptions): AsyncIterable<StreamEvent> {
    this.calls++;
    this.toolCounts.push(req.tools?.length ?? 0);
    if (this.calls === 1) {
      yield {
        type: "tool-call",
        call: { id: "read-1", name: "read_file", args: { path: "src/app.ts" } },
      };
      yield { type: "finish", reason: "tool-calls", usage: { input: 80, output: 0 }, model: "m" };
      return;
    }
    yield { type: "text-delta", text: '{"verdict":"pass"}' };
    yield { type: "finish", reason: "stop", usage: { input: 100, output: 10 }, model: "m" };
  }
  async embed() {
    return [0];
  }
}

class DefiantConvergingProvider implements Provider {
  calls = 0;
  toolCounts: number[] = [];
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(req: ChatOptions): AsyncIterable<StreamEvent> {
    this.calls++;
    this.toolCounts.push(req.tools?.length ?? 0);
    if (this.calls <= 2) {
      yield {
        type: "tool-call",
        call: { id: `read-${this.calls}`, name: "read_file", args: { path: "src/app.ts" } },
      };
      yield { type: "finish", reason: "tool-calls", usage: { input: 80, output: 0 }, model: "m" };
      return;
    }
    yield { type: "text-delta", text: '{"verdict":"pass"}' };
    yield { type: "finish", reason: "stop", usage: { input: 100, output: 10 }, model: "m" };
  }
  async embed() {
    return [0];
  }
}

const readFileStub: Tool = {
  name: "read_file",
  description: "read a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  mutates: false,
  serialize: () => "read_file",
  run: async () => ({ ok: true, output: "export const app = true;" }),
};

function workerOpts(provider: Provider): AgentRuntimeOptions {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  return {
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log: { append: (e: EventInput) => ({ ...e, id: "x", ts: 0 }) },
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "PARENT-PROMPT",
    projectDir: "/tmp",
    resolvePermission: async () => "allow",
    maxToolLoops: 10,
  };
}

function inspectingWorkerOpts(provider: Provider): AgentRuntimeOptions {
  const opts = workerOpts(provider);
  opts.tools.register(readFileStub);
  return opts;
}

test("general workers receive an edit-now nudge after four inspection-only rounds", async () => {
  const provider = new InspectingProvider(4);
  const result = await buildOrchestrationWorkerSpawner(inspectingWorkerOpts(provider), {
    sessionId: "MAIN",
  })({
    type: "general",
    prompt: "implement it",
    signal: new AbortController().signal,
    taskId: "t-edit",
    title: "Build component",
  });

  expect(result.stoppedReason).toBeUndefined();
  expect(provider.calls).toBe(5);
  expect(provider.sawEditNudge).toBe(true);
});

test("explore workers are exempt from the edit-based no-progress watchdog", async () => {
  const provider = new InspectingProvider(2, true);
  const opts = inspectingWorkerOpts(provider);
  opts.workerNoProgressTokens = 50;
  const result = await buildOrchestrationWorkerSpawner(opts, { sessionId: "MAIN" })({
    type: "explore",
    prompt: "map exports",
    signal: new AbortController().signal,
    taskId: "t-explore",
    title: "Map exports",
  });

  expect(result.stoppedReason).toBeUndefined();
  expect(result.assistantText).toBe("done");
  expect(provider.calls).toBe(3);
  expect(provider.sawEditNudge).toBe(false);
});

test("worker prompt gets the voice directive only when a personality voice is active", async () => {
  const sig = new AbortController().signal;

  const voiced = new CapturingProvider();
  await buildOrchestrationWorkerSpawner(workerOpts(voiced), {
    sessionId: "MAIN",
    voiceOverlay: () => "VOICE — folksy drawl",
  })({ type: "general", prompt: "x", signal: sig, taskId: "t1", title: "T" });
  expect(voiced.lastSystem).toContain("PARENT-PROMPT"); // base preserved
  expect(voiced.lastSystem.toUpperCase()).toContain("VOICE"); // directive present

  const neutral = new CapturingProvider();
  await buildOrchestrationWorkerSpawner(workerOpts(neutral), {
    sessionId: "MAIN",
    voiceOverlay: () => "", // neutral
  })({ type: "general", prompt: "x", signal: sig, taskId: "t1", title: "T" });
  expect(neutral.lastSystem.toLowerCase()).not.toContain("in-character"); // no directive

  const unset = new CapturingProvider();
  await buildOrchestrationWorkerSpawner(workerOpts(unset), { sessionId: "MAIN" })({
    type: "general",
    prompt: "x",
    signal: sig,
    taskId: "t1",
    title: "T",
  });
  expect(unset.lastSystem.toLowerCase()).not.toContain("in-character"); // absent thunk → no directive
});

test("worker events are stamped actor:worker+taskId and land on the given session id", async () => {
  const appended: EventInput[] = [];
  const log = {
    append: (e: EventInput) => {
      appended.push(e);
      return { ...e, id: "x", ts: 0 };
    },
  };

  const provider = new ScriptedProvider([
    [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop" },
    ],
  ]);

  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();

  const parentOpts: AgentRuntimeOptions = {
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "PARENT-PROMPT",
    projectDir: "/tmp",
    resolvePermission: async () => "allow",
    maxToolLoops: 10,
  };

  const spawn = buildOrchestrationWorkerSpawner(parentOpts, { sessionId: "MAIN" });
  await spawn({
    type: "general",
    prompt: "do it",
    signal: new AbortController().signal,
    taskId: "t3",
    title: "T",
  });

  const tagged = appended.filter((e) => (e.payload as { actor?: unknown }).actor);
  expect(tagged.length).toBeGreaterThan(0);
  expect(tagged.every((e) => e.sessionId === "MAIN")).toBe(true);
  expect((tagged[0]!.payload as { actor: { role: string; taskId: string } }).actor).toEqual({
    role: "worker",
    taskId: "t3",
  });
});

test("protocol worker marks terminal assistant output as internal while retaining it in the log", async () => {
  const appended: EventInput[] = [];
  const provider = new ScriptedProvider([
    [
      { type: "text-delta", text: '{"verdict":"pass"}' },
      { type: "finish", reason: "stop" },
    ],
  ]);
  const opts = workerOpts(provider);
  opts.log = {
    append(e) {
      appended.push(e);
      return { ...e, id: "x", ts: 0 };
    },
  };
  await buildOrchestrationWorkerSpawner(opts, { sessionId: "MAIN" })({
    type: "review",
    prompt: "verify",
    signal: new AbortController().signal,
    taskId: "integration-verify",
    title: "Verify",
    protocolOutput: true,
    convergeEarly: true,
  });
  const message = appended.find((event) => event.type === "assistant_message")!;
  expect((message.payload as { internalProtocol?: boolean }).internalProtocol).toBe(true);
  expect(
    (appended.find((event) => event.type === "user_input")!.payload as { text: string }).text,
  ).toContain("CONVERGENCE RULE");
});

test("converging workers reserve a tool-less final response before the hard token ceiling", async () => {
  const provider = new ConvergingProvider();
  const opts = inspectingWorkerOpts(provider);
  opts.workerTurnTokens = 100;
  const result = await buildOrchestrationWorkerSpawner(opts, { sessionId: "MAIN" })({
    type: "review",
    prompt: "verify",
    signal: new AbortController().signal,
    taskId: "integration-verify",
    title: "Verify",
    convergeEarly: true,
  });
  expect(result.stoppedReason).toBeUndefined();
  expect(result.assistantText).toBe('{"verdict":"pass"}');
  expect(provider.toolCounts[0]).toBeGreaterThan(0);
  expect(provider.toolCounts[1]).toBe(0);
});

test("converging workers correct one tool call emitted after tool access closes", async () => {
  const provider = new DefiantConvergingProvider();
  const opts = inspectingWorkerOpts(provider);
  opts.workerTurnTokens = 100;
  const result = await buildOrchestrationWorkerSpawner(opts, { sessionId: "MAIN" })({
    type: "review",
    prompt: "verify",
    signal: new AbortController().signal,
    taskId: "integration-verify",
    title: "Verify",
    convergeEarly: true,
  });
  expect(result.stoppedReason).toBeUndefined();
  expect(result.assistantText).toBe('{"verdict":"pass"}');
  expect(provider.toolCounts).toEqual([expect.any(Number), 0, 0]);
});

test("worker turn is seeded with the given skill reminders", async () => {
  const sig = new AbortController().signal;
  const cap = new CapturingProvider();
  await buildOrchestrationWorkerSpawner(workerOpts(cap), { sessionId: "MAIN" })({
    type: "general",
    prompt: "do the task",
    signal: sig,
    taskId: "t1",
    title: "T",
    seedReminders: ["<system-reminder>SEED-TDD</system-reminder>"],
  });
  expect(cap.lastUser).toContain("do the task"); // original prompt preserved
  expect(cap.lastUser).toContain("SEED-TDD"); // seed injected
});

test("a seed identical to a task-text trigger is not duplicated", async () => {
  const sig = new AbortController().signal;
  const cap = new CapturingProvider();
  const opts = workerOpts(cap);
  // The task-text base path now flows through the spawner's execute-scoped `workerSkillSeed`
  // resolver (not the parent's inline resolver). Make it emit the SAME reminder as the seed so
  // the seed∪base dedup is genuinely exercised (see the base-trigger-leak fix, Task 6/D4).
  await buildOrchestrationWorkerSpawner(opts, {
    sessionId: "MAIN",
    workerSkillSeed: () => ["<system-reminder>SEED-TDD</system-reminder>"],
  })({
    type: "general",
    prompt: "do the task",
    signal: sig,
    taskId: "t1",
    title: "T",
    seedReminders: ["<system-reminder>SEED-TDD</system-reminder>"],
  });
  const occurrences = cap.lastUser.split("SEED-TDD").length - 1;
  expect(occurrences).toBe(1);
});

test("no seed → worker turn carries no reminder", async () => {
  const sig = new AbortController().signal;
  const cap = new CapturingProvider();
  await buildOrchestrationWorkerSpawner(workerOpts(cap), { sessionId: "MAIN" })({
    type: "general",
    prompt: "do the task",
    signal: sig,
    taskId: "t1",
    title: "T",
  });
  expect(cap.lastUser).not.toContain("SEED-TDD");
});

// --- Task 6: worker base-trigger leak is execute-scoped -------------------------------------

const tddSkill: Skill = {
  name: "tdd-skill",
  description: "tdd",
  source: "built-in",
  body: "TDD-BODY-MARKER",
  trigger: { when: [], match: ["do-the-thing"] },
  scope: "decompose",
};

const implSkill: Skill = {
  name: "impl-skill",
  description: "impl",
  source: "built-in",
  body: "IMPL-BODY-MARKER",
  trigger: { when: [], match: ["do-the-thing"] },
  scope: "execute",
};

test("worker task-text path is execute-scoped: a decompose-only skill is not injected", async () => {
  const sig = new AbortController().signal;
  const cap = new CapturingProvider();
  const list = [tddSkill, implSkill];
  const workerSkillSeed = (input: string) => renderWorkerSeed(triggeredSkills(list, input));

  await buildOrchestrationWorkerSpawner(workerOpts(cap), {
    sessionId: "MAIN",
    workerSkillSeed,
  })({
    type: "general",
    prompt: "please do-the-thing now",
    signal: sig,
    taskId: "t1",
    title: "T",
  });

  expect(cap.lastUser).toContain("IMPL-BODY-MARKER"); // execute-scoped skill reaches the worker
  expect(cap.lastUser).not.toContain("TDD-BODY-MARKER"); // decompose-only skill does not
});

test("deps absent → base is empty (byte-identical disabled path)", async () => {
  const sig = new AbortController().signal;
  const cap = new CapturingProvider();

  // No opts.workerSkillSeed: even though the prompt would trigger both skills inline, the
  // worker's base must stay empty — only the (possibly empty) seed survives the union.
  await buildOrchestrationWorkerSpawner(workerOpts(cap), { sessionId: "MAIN" })({
    type: "general",
    prompt: "please do-the-thing now",
    signal: sig,
    taskId: "t1",
    title: "T",
    seedReminders: ["<system-reminder>SEED-ONLY-MARKER</system-reminder>"],
  });

  expect(cap.lastUser).toContain("SEED-ONLY-MARKER"); // seed still present
  expect(cap.lastUser).not.toContain("IMPL-BODY-MARKER");
  expect(cap.lastUser).not.toContain("TDD-BODY-MARKER");
});
