import { expect, test } from "bun:test";
import type { BuildGateResult } from "../../src/agent/build-gate/gate";
import {
  type OrchestrationPlan,
  Orchestrator,
  type OrchestratorDeps,
  composeWorkerPrompt,
  parseSemanticReport,
  parseStructuredPlan,
  workerFailedToProduceChanges,
} from "../../src/agent/orchestrator";
import { CLOSING_SYSTEM } from "../../src/agent/orchestrator-prompts";
import { DEFAULT_ORCHESTRATION } from "../../src/config/orchestration";
import type { EventInput } from "../../src/events/types";

function planJson(titles: string[]): string {
  return JSON.stringify({
    brief: "brief",
    tasks: titles.map((t) => ({
      title: t,
      description: `do ${t}`,
      agent_type: "general",
      acceptance: [`verify ${t} is wired`],
    })),
  });
}

function semanticJson(
  verdict: "pass" | "fail",
  requirement = "Requested behavior is wired",
): string {
  return JSON.stringify({
    verdict,
    summary: verdict === "pass" ? "Repository satisfies the approved plan." : "Wiring is missing.",
    checks: [
      {
        requirement,
        status: verdict,
        evidence:
          verdict === "pass"
            ? "src/App.tsx imports and renders the requested component."
            : "src/alt/App.tsx only re-exports the old App.",
        ...(verdict === "fail" ? { repair: "Compose and render the new components." } : {}),
      },
    ],
  });
}

test("semantic report parser rejects contradictory pass verdicts", () => {
  const report = parseSemanticReport(
    JSON.stringify({
      verdict: "pass",
      summary: "claimed pass",
      checks: [
        {
          requirement: "Alt root is wired",
          status: "fail",
          evidence: "The module re-exports the default root.",
          repair: "Render the alt components.",
        },
      ],
    }),
  );
  expect(report?.verdict).toBe("fail");
});

test("semantic report parser preserves failures when pass checks use empty repair strings", () => {
  const report = parseSemanticReport(
    JSON.stringify({
      verdict: "fail",
      summary: "Lint and visual acceptance failed.",
      checks: [
        {
          requirement: "CLI flag is wired",
          status: "pass",
          evidence: "src/bin/cleetus.ts reaches the alternate root.",
          repair: "",
        },
        {
          requirement: "Full reskin is implemented",
          status: "fail",
          evidence: "AltApp only wraps the unchanged App.",
          repair: "Restyle the transcript, composer, and pickers.",
        },
      ],
    }),
  );

  expect(report).toEqual({
    verdict: "fail",
    summary: "Lint and visual acceptance failed.",
    checks: [
      {
        requirement: "CLI flag is wired",
        status: "pass",
        evidence: "src/bin/cleetus.ts reaches the alternate root.",
        repair: undefined,
      },
      {
        requirement: "Full reskin is implemented",
        status: "fail",
        evidence: "AltApp only wraps the unchanged App.",
        repair: "Restyle the transcript, composer, and pickers.",
      },
    ],
  });
});

/** Build deps with scripted callModel replies (consumed in order) and a worker recorder. */
function makeDeps(
  modelReplies: string[],
  worker: (prompt: string) => Promise<string>,
  overrides: Partial<OrchestratorDeps["config"]> = {},
  workerCounts: { successfulEdits: number; failedWrites: number } = {
    successfulEdits: 0,
    failedWrites: 0,
  },
  stoppedReason?:
    | "token_budget"
    | "time_budget"
    | "thrash"
    | "hidden_tools"
    | "no_progress"
    | "premature_completion"
    | "provider_error"
    | "stream_watchdog",
): {
  deps: OrchestratorDeps;
  events: EventInput[];
  workerPrompts: string[];
  systems: string[];
  users: string[];
  workerSeeds: (string[] | undefined)[];
  workerPendingTitles: string[][];
  recorded: string[];
} {
  const events: EventInput[] = [];
  const workerPrompts: string[] = [];
  const systems: string[] = [];
  const users: string[] = [];
  const workerSeeds: (string[] | undefined)[] = [];
  const workerPendingTitles: string[][] = [];
  const recorded: string[] = [];
  const replies = [...modelReplies];
  const deps: OrchestratorDeps = {
    config: { ...DEFAULT_ORCHESTRATION, enabled: true, ...overrides },
    orchestratorModel: () => "orch",
    callModel: async (_model, system, user) => {
      systems.push(system);
      users.push(user);
      return replies.shift() ?? "";
    },
    spawnWorker: async ({ prompt, seedReminders, pendingTitles }) => {
      workerPrompts.push(prompt);
      workerSeeds.push(seedReminders);
      workerPendingTitles.push(pendingTitles ?? []);
      return {
        assistantText: await worker(prompt),
        ...workerCounts,
        stoppedReason,
        editedPaths: [],
      };
    },
    log: { append: (e) => events.push(e) },
    sessionId: "s1",
    // Mirrors runtime.recordOrchestrationSummary: emits the assistant_message event (so existing
    // `events.find(assistant_message)` assertions keep working) AND captures the raw writeback.
    recordSummary: (text) => {
      recorded.push(text);
      events.push({ sessionId: "s1", type: "assistant_message", payload: { text } });
    },
  };
  return {
    deps,
    events,
    workerPrompts,
    systems,
    users,
    workerSeeds,
    workerPendingTitles,
    recorded,
  };
}

const ac = () => new AbortController().signal;

test("folds user instructions into the structuring + replan system prompts (#142)", async () => {
  const { deps, systems } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "done"],
    async () => "worker ok",
    {},
    { successfulEdits: 0, failedWrites: 1 }, // C1: replan only fires on failure — force one
  );
  deps.userInstructions = () => "Prefer Bun over npm.";
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  // systems[0] = structure, systems[1] = replan(after A) — both must carry the preference.
  expect(systems[0]).toContain("Prefer Bun over npm.");
  expect(systems[1]).toContain("Prefer Bun over npm.");
});

test("omits the instructions block when there are no user instructions", async () => {
  const { deps, systems } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "done"],
    async () => "ok",
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(systems[0]).not.toContain("USER INSTRUCTIONS");
});

test("threads the project directory into the structuring prompt (sibling-root fix)", async () => {
  const { deps, users } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "done"],
    async () => "ok",
  );
  deps.projectDir = "/home/me/proj";
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  // users[0] = structuring prompt; must name the existing project dir so the decomposer
  // scaffolds INTO it instead of authoring a "create a new root folder" task.
  expect(users[0]).toContain("/home/me/proj");
});

test("folds decomposition skill guidance into the structuring system prompt", async () => {
  const { deps, systems } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "done"],
    async () => "ok",
  );
  deps.decomposeGuidance = (input) => (input === "req" ? "SKILL DISCIPLINES — do TDD" : "");
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(systems[0]).toContain("SKILL DISCIPLINES — do TDD");
});

test("structuring prompt omits skill guidance when the dep is absent", async () => {
  const { deps, systems } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "done"],
    async () => "ok",
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(systems[0]).not.toContain("SKILL DISCIPLINES");
});

test("seeds every worker with skill reminders computed from the objective", async () => {
  const { deps, workerSeeds } = makeDeps(
    [planJson(["A", "B"]), JSON.stringify({ tasks: [] }), "done"],
    async () => "ok",
  );
  deps.workerSkillSeed = (input) =>
    input === "req" ? ["<system-reminder>SEED</system-reminder>"] : [];
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(workerSeeds.length).toBeGreaterThan(0);
  expect(workerSeeds.every((s) => s?.[0] === "<system-reminder>SEED</system-reminder>")).toBe(true);
});

test("worker seed is empty when the dep is absent", async () => {
  const { deps, workerSeeds } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "done"],
    async () => "ok",
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(workerSeeds.every((s) => (s ?? []).length === 0)).toBe(true);
});

test("worker receives the still-pending task titles as pendingTitles (first task → the rest)", async () => {
  // 2-task plan, both succeed (no replan needed). The FIRST worker's pendingTitles must be ["B"];
  // the SECOND worker's pendingTitles must be [] (nothing left pending).
  const { deps, workerPendingTitles } = makeDeps(
    [planJson(["A", "B"]), "done"],
    async () => "ok",
    {},
    { successfulEdits: 1, failedWrites: 0 }, // success → no replan
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(workerPendingTitles[0]).toEqual(["B"]);
  expect(workerPendingTitles[1]).toEqual([]);
});

test("happy path: structures, runs each worker, emits a summary", async () => {
  // C1: both tasks succeed → no replan calls at all. callModel order: structure → closing.
  const { deps, events, workerPrompts } = makeDeps(
    [planJson(["A", "B"]), "All done: A and B complete."],
    async () => "worker ok",
  );
  const res = await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(res.kind).toBe("ran");
  expect(workerPrompts).toHaveLength(2);
  expect(workerPrompts[0]).toContain("do A");
  expect(workerPrompts[0]).toContain("Acceptance criteria");
  expect(workerPrompts[0]).toContain("verify A is wired");
  expect(workerPrompts[0]).toContain("## Project brief"); // brief injected
  const summary = events.find((e) => e.type === "assistant_message");
  expect((summary!.payload as { text: string }).text).toContain("All done");
});

test("kickoff notice appends the roster line when provided", async () => {
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "done"],
    async () => "ok",
  );
  deps.rosterLine = () => "planner nemotron3:33b (lab_ollama) · worker north-mini (lab_ollama)";
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  const kickoff = events.find(
    (e) => e.type === "notice" && /^Orchestrating/.test((e.payload as { text: string }).text),
  );
  expect((kickoff!.payload as { text: string }).text).toBe(
    "Orchestrating 1 task(s). · planner nemotron3:33b (lab_ollama) · worker north-mini (lab_ollama)",
  );
});

test("structuring failure stops honestly without starting workers or a single pass", async () => {
  const { deps, events, workerPrompts } = makeDeps(
    ["not json", "still not json", "also not json"],
    async () => "x",
  );
  const res = await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(res.kind).toBe("fallback");
  expect(workerPrompts).toHaveLength(0);
  expect(
    events.some(
      (e) =>
        e.type === "notice" &&
        (e.payload as { text: string }).text.includes(
          "Orchestration stopped: could not produce a safe task decomposition.",
        ) &&
        (e.payload as { text: string }).text.includes("No implementation was started"),
    ),
  ).toBe(true);
});

test("noticeStructureFailure emits an authoritative stop for the TUI direct-drive path", () => {
  const { deps, events } = makeDeps([], async () => "x");
  new Orchestrator(deps).noticeStructureFailure();
  const n = events.find((e) => e.type === "notice");
  expect(n).toBeDefined();
  const payload = n!.payload as { text: string; level: string };
  expect(payload.text).toContain(
    "Orchestration stopped: could not produce a safe task decomposition.",
  );
  expect(payload.text).toContain("repair the decomposition or choose another execution path");
  expect(payload.level).toBe("warn");
});

test("successful closing summary carries the voice overlay; structure stays voiceless", async () => {
  // #119: the orchestrator's user-facing CLOSING summary must reflect the active personality voice
  // (otherwise orchestrated runs read as voiceless). Structuring/replan must stay clean — voice in
  // them risks breaking JSON parsing (cf. #118).
  const systems: string[] = [];
  const replies = [planJson(["A"]), "summary"];
  const deps: OrchestratorDeps = {
    config: { ...DEFAULT_ORCHESTRATION, enabled: true },
    orchestratorModel: () => "orch",
    callModel: async (_model, system) => {
      systems.push(system);
      return replies.shift() ?? "";
    },
    spawnWorker: async () => ({
      assistantText: "ok",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: ["src/a.ts"],
    }),
    voiceOverlay: () => "VOICE — folksy drawl",
    log: { append: () => {} },
    sessionId: "s1",
    recordSummary: () => {},
  };
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  // call order: structure, closing
  expect(systems[0]).not.toContain("VOICE — folksy drawl"); // structure → pure JSON
  expect(systems[systems.length - 1]).toContain("VOICE — folksy drawl"); // closing → voiced
  expect(systems[systems.length - 1]).toContain(CLOSING_SYSTEM); // …without dropping the role
});

test("neutral (empty overlay) leaves the closing system byte-identical", async () => {
  const systems: string[] = [];
  const replies = [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"];
  const deps: OrchestratorDeps = {
    config: { ...DEFAULT_ORCHESTRATION, enabled: true },
    orchestratorModel: () => "orch",
    callModel: async (_model, system) => {
      systems.push(system);
      return replies.shift() ?? "";
    },
    spawnWorker: async () => ({
      assistantText: "ok",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: [],
    }),
    voiceOverlay: () => "", // neutral
    log: { append: () => {} },
    sessionId: "s1",
    recordSummary: () => {},
  };
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(systems[systems.length - 1]).toBe(CLOSING_SYSTEM); // unchanged when no voice
});

test("worker throw is retried then marked failed; loop continues", async () => {
  let calls = 0;
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"],
    async () => {
      calls++;
      throw new Error("boom");
    },
    { maxTaskRetries: 1 },
  );
  const res = await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(res.kind).toBe("ran");
  expect(calls).toBe(2); // initial + 1 retry
  expect(
    events.some((e) => e.type === "notice" && /failed/i.test((e.payload as { text: string }).text)),
  ).toBe(true);
});

test("maxReplans bounds planner calls while retry exhaustion may continue preserved work", async () => {
  const replies = [planJson(["A", "B", "C", "D", "E"])];
  for (let i = 0; i < 50; i++) replies.push(planJson(["X"]));
  replies.push("forced summary");
  const { deps, workerPrompts, systems } = makeDeps(
    replies,
    async () => "ok",
    { maxReplans: 3 },
    { successfulEdits: 0, failedWrites: 1 }, // C1: force every task to fail so each iteration replans
  );
  const res = await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(res.kind).toBe("ran");
  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(3);
  expect(workerPrompts.length).toBeLessThanOrEqual(20);
});

test("a replan-updated brief is injected into later worker prompts", async () => {
  const { deps, workerPrompts } = makeDeps(
    [
      planJson(["A", "B"]),
      JSON.stringify({ brief: "UPDATED BRIEF", tasks: [{ title: "B", description: "do B" }] }),
      JSON.stringify({ tasks: [] }),
      "done",
    ],
    async () => "ok",
    {},
    { successfulEdits: 0, failedWrites: 1 }, // failed A is retried, then original B remains
  );
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(workerPrompts).toHaveLength(3);
  expect(workerPrompts[1]).toContain("UPDATED BRIEF"); // recovery worker sees the updated brief
});

test("abort after the first task stops the loop and still summarizes", async () => {
  const controller = new AbortController();
  let workerCalls = 0;
  const events: EventInput[] = [];
  const replies = [planJson(["A", "B"]), planJson(["B"]), "done"];
  const deps: OrchestratorDeps = {
    config: { ...DEFAULT_ORCHESTRATION, enabled: true },
    orchestratorModel: () => "orch",
    callModel: async () => replies.shift() ?? "",
    spawnWorker: async () => {
      workerCalls++;
      controller.abort(); // abort during the first worker
      return { assistantText: "ok", successfulEdits: 1, failedWrites: 0, editedPaths: [] };
    },
    log: { append: (e) => events.push(e) },
    sessionId: "s1",
    recordSummary: (text) =>
      events.push({ sessionId: "s1", type: "assistant_message", payload: { text } }),
  };
  const res = await new Orchestrator(deps).run({
    request: "r",
    prosePlan: "p",
    signal: controller.signal,
  });
  expect(res.kind).toBe("ran");
  expect(workerCalls).toBe(1); // second task never dispatched after abort
  expect(events.some((e) => e.type === "assistant_message")).toBe(true); // closing still fires
});

test("empty closing reply yields a deterministic fallback summary", async () => {
  // C1: task A succeeds → no replan call; only structure + closing are scripted.
  const { deps, events } = makeDeps(
    [planJson(["A"]), ""], // closing returns ""
    async () => "ok",
  );
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  const summary = events.find((e) => e.type === "assistant_message");
  expect((summary!.payload as { text: string }).text).toContain("Orchestration finished");
});

test("structure() returns a parsed plan; execute() runs it", async () => {
  const { deps, workerPrompts } = makeDeps(
    [
      // structure() consumes reply[0]:
      JSON.stringify({
        brief: "b",
        tasks: [{ title: "A", description: "do A", agent_type: "general" }],
      }),
      JSON.stringify({ tasks: [] }), // execute(): replan after task A → null → pending stays empty
      "summary", // execute(): closing
    ],
    async () => "ok",
  );
  const orch = new Orchestrator(deps);
  const plan = await orch.structure({ request: "r", prosePlan: "p", signal: ac() });
  expect(plan).not.toBeNull();
  expect(plan!.tasks).toHaveLength(1);
  const res = await orch.execute(plan!, ac());
  expect(res.kind).toBe("ran");
  expect(workerPrompts).toHaveLength(1);
});

test("execute writes back the orchestration outcome (facts) to recordSummary", async () => {
  let written: string | null = null;
  let calls = 0;
  // Replan fires once (after t2's budget-kill); its empty task list drains `pending`, then the
  // unconditional closing call produces the model prose.
  const replies = [JSON.stringify({ tasks: [] }), "closing prose"];
  const deps: OrchestratorDeps = {
    config: { ...DEFAULT_ORCHESTRATION, enabled: true },
    orchestratorModel: () => "orch",
    callModel: async () => replies.shift() ?? "",
    spawnWorker: async () => {
      calls++;
      return calls === 1
        ? { assistantText: "ok", successfulEdits: 1, failedWrites: 0, editedPaths: ["src/foo.ts"] }
        : {
            assistantText: "ok",
            successfulEdits: 0,
            failedWrites: 0,
            editedPaths: [],
            stoppedReason: "token_budget" as const,
          };
    },
    log: { append: () => {} },
    sessionId: "s1",
    recordSummary: (t) => {
      written = t;
    },
  };
  const plan: OrchestrationPlan = {
    brief: "brief",
    objective: "req",
    location: { kind: "cwd" },
    tasks: [
      {
        id: "t1",
        title: "Task one",
        description: "do one",
        agentType: "general",
        status: "pending",
      },
      {
        id: "t2",
        title: "Task two",
        description: "do two",
        agentType: "general",
        status: "pending",
      },
    ],
  };
  await new Orchestrator(deps).execute(plan, ac());
  expect(written).not.toBeNull();
  expect(written!).toContain("I built this via orchestrated workers:");
  expect(written!).toContain("✓"); // t1 → src/foo.ts
  expect(written!).toContain("src/foo.ts");
  expect(written!).toContain("✗"); // t2 incomplete
});

test("structure() passes the plan schema as kind:'json' responseFormat", async () => {
  const captured: unknown[] = [];
  const deps: OrchestratorDeps = {
    config: { ...DEFAULT_ORCHESTRATION, enabled: true },
    orchestratorModel: () => "orch",
    callModel: async (_model, _system, _user, _signal, responseFormat) => {
      captured.push(responseFormat);
      return planJson(["A"]);
    },
    spawnWorker: async () => ({
      assistantText: "ok",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: [],
    }),
    log: { append: () => {} },
    sessionId: "s1",
    recordSummary: () => {},
  };
  const orch = new Orchestrator(deps);
  await orch.structure({ request: "r", prosePlan: "p", signal: ac() });
  expect(captured[0]).toMatchObject({ name: "plan", kind: "json" });
});

test("structure reprompts an oversized UI bundle before task-list approval", async () => {
  const oversized = JSON.stringify({
    brief: "alt UI",
    tasks: [
      {
        title: "Build app, header, transcript, tool-line, reasoning-panel, and footer",
        description: "Create every listed TUI component",
        agent_type: "general",
        acceptance: ["the UI compiles"],
      },
    ],
  });
  const corrected = JSON.stringify({
    brief: "alt UI",
    tasks: [
      {
        title: "Build transcript flow",
        description: "Create transcript and tool-line with rendered interaction tests",
        agent_type: "general",
        acceptance: ["render test proves tool expansion"],
      },
    ],
  });
  const { deps, users, events } = makeDeps([oversized, corrected], async () => "unused");

  const plan = await new Orchestrator(deps).structure({
    request: "build an alt UI",
    prosePlan: "full alternate UI",
    signal: ac(),
  });

  expect(plan?.tasks.map((task) => task.title)).toEqual(["Build transcript flow"]);
  expect(users[1]).toContain("PREVIOUS PLAN REJECTED");
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        (event.payload as { text: string }).text.includes(
          'task "Build app, header, transcript, tool-line, reasoning-panel, and footer" owns',
        ),
    ),
  ).toBe(true);
});

test("structure normalizes runtime-owned gates without spending a corrective model call", async () => {
  const candidate = JSON.stringify({
    brief: "health",
    tasks: [
      {
        title: "Implement runtime interventions analyzer",
        description:
          "Implement src/insights/analyzers/runtime-interventions.ts. Run the full test suite.",
        agent_type: "general",
        acceptance: [
          "bun test tests/insights/analyzers/runtime-interventions.test.ts",
          "bun run typecheck passes",
        ],
      },
    ],
  });
  const { deps, users, events } = makeDeps([candidate], async () => "unused");

  const plan = await new Orchestrator(deps).structure({
    request: "add orchestration health",
    prosePlan: "approved plan",
    signal: ac(),
  });

  expect(users).toHaveLength(1);
  expect(plan?.tasks[0]?.acceptanceCriteria).toEqual([
    "bun test tests/insights/analyzers/runtime-interventions.test.ts",
  ]);
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        (event.payload as { text: string }).text.includes("Structuring normalized"),
    ),
  ).toBe(true);
});

test("structure stops early when the model repeats the same rejected candidate", async () => {
  const oversized = JSON.stringify({
    brief: "alt UI",
    tasks: [
      {
        title: "Build app, header, transcript, tool-line, reasoning-panel, and footer",
        description: "Create every listed TUI component",
        agent_type: "general",
        acceptance: ["render everything"],
      },
    ],
  });
  const { deps, users, events } = makeDeps([oversized, oversized, oversized], async () => "unused");
  const orchestrator = new Orchestrator(deps);

  const plan = await orchestrator.structure({
    request: "build UI",
    prosePlan: "plan",
    signal: ac(),
  });

  expect(plan).toBeNull();
  expect(users).toHaveLength(2);
  expect(orchestrator.getLastStructureFailure()).toMatchObject({
    attempts: 2,
    repeated: true,
  });
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        (event.payload as { text: string }).text.includes("repeated the same rejected"),
    ),
  ).toBe(true);
});

test("parseStructuredPlan handles a bare constrained-JSON response (no fence, no prose)", () => {
  const plan = parseStructuredPlan(
    '{"brief":"b","tasks":[{"title":"t","description":"d","agent_type":"explore"}]}',
    10,
  );
  expect(plan?.tasks[0]).toMatchObject({ title: "t", agentType: "explore" });
});

test("parseStructuredPlan retains task acceptance criteria", () => {
  const plan = parseStructuredPlan(
    '{"brief":"b","tasks":[{"title":"wire","description":"compose it","agent_type":"general","acceptance":["entry point renders the new component","focused test passes"]}]}',
    10,
  );
  expect(plan?.tasks[0]?.acceptanceCriteria).toEqual([
    "entry point renders the new component",
    "focused test passes",
  ]);
});

test("orchestratorModel is resolved LIVE per call (mirrors a changing session model)", async () => {
  // Regression for subdesk3: orchestration must use the live session model, not a startup snapshot.
  const models: string[] = [];
  let current = "modelA";
  const replies = [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"];
  const deps: OrchestratorDeps = {
    config: { ...DEFAULT_ORCHESTRATION, enabled: true },
    orchestratorModel: () => current,
    callModel: async (model) => {
      models.push(model);
      return replies.shift() ?? "";
    },
    spawnWorker: async () => ({
      assistantText: "ok",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: [],
    }),
    log: { append: () => {} },
    sessionId: "s1",
    recordSummary: () => {},
  };
  const orch = new Orchestrator(deps);
  const plan = await orch.structure({ request: "r", prosePlan: "p", signal: ac() });
  current = "modelB"; // session model switched between structure and execute
  await orch.execute(plan!, ac());
  expect(models[0]).toBe("modelA"); // structuring used the model live at that time
  expect(models[models.length - 1]).toBe("modelB"); // closing used the updated model live
});

test("integration check: one violation → runs a corrective worker, re-checks, resolves", async () => {
  const { deps, events, workerPrompts } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"],
    async () => "ok",
  );
  let n = 0;
  deps.inspectProject = async () =>
    n++ === 0
      ? [{ rule: "tailwind-v4-vite-plugin", problem: "unstyled", fix: "wire the plugin" }]
      : [];
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(workerPrompts).toHaveLength(2); // task A + the corrective worker
  expect(workerPrompts[1]).toContain("wire the plugin"); // corrective prompt = violation.fix
  expect(
    events.some(
      (e) =>
        e.type === "notice" && /wiring issues resolved/i.test((e.payload as { text: string }).text),
    ),
  ).toBe(true);
});

test("integration check: no violations → no extra worker, no integration notice", async () => {
  const { deps, events, workerPrompts } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"],
    async () => "ok",
  );
  deps.inspectProject = async () => [];
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(workerPrompts).toHaveLength(1);
  expect(
    events.some(
      (e) => e.type === "notice" && /Integration check/.test((e.payload as { text: string }).text),
    ),
  ).toBe(false);
});

test("integration check: still violated after the fix → 'issue(s) remain' notice", async () => {
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"],
    async () => "ok",
  );
  deps.inspectProject = async () => [{ rule: "x", problem: "p", fix: "f" }]; // always violated
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(
    events.some(
      (e) => e.type === "notice" && /issue\(s\) remain/.test((e.payload as { text: string }).text),
    ),
  ).toBe(true);
});

test("structure() freezes the original request as the plan objective (#168)", async () => {
  const { deps } = makeDeps([planJson(["A", "B"])], async () => "ok");
  const plan = await new Orchestrator(deps).structure({
    request: "add a nav item and a new page",
    prosePlan: "1. nav\n2. page",
    signal: ac(),
  });
  expect(plan).not.toBeNull();
  expect(plan!.objective).toBe("add a nav item and a new page");
});

test("scope guard bounds added recovery work while preserving original tasks (#168)", async () => {
  // initialCount 3 → total budget 6 → three recovery slots. After A fails, B and C remain
  // protected while only X0..X2 are admitted and X3..X9 are deferred.
  const runaway = JSON.stringify({
    brief: "brief",
    tasks: Array.from({ length: 10 }, (_, i) => ({
      title: `X${i}`,
      description: `do X${i}`,
      agent_type: "general",
    })),
  });
  const { deps, events } = makeDeps(
    [planJson(["A", "B", "C"]), runaway, JSON.stringify({ tasks: [] }), "summary"],
    async () => "ok",
    {},
    { successfulEdits: 0, failedWrites: 1 }, // C1: force failures so the replan calls fire
  );
  await new Orchestrator(deps).run({
    request: "add a nav item and a page",
    prosePlan: "p",
    signal: ac(),
  });
  const guard = events.find(
    (e) => e.type === "notice" && /Scope guard/.test((e.payload as { text: string }).text),
  );
  expect(guard).toBeDefined();
  expect((guard!.payload as { text: string }).text).toContain("7 additional recovery task(s)");
  expect((guard!.payload as { text: string }).text).toContain(
    "original pending tasks were preserved",
  );
});

test("an in-budget replan is not clamped and emits no scope notice (#168)", async () => {
  // initialCount 3 → budget 6. After task A (done=1), replan proposes 4 tasks; room = 5 → no drop.
  const inBudget = JSON.stringify({
    brief: "brief",
    tasks: ["B", "C", "D", "E"].map((t) => ({
      title: t,
      description: `do ${t}`,
      agent_type: "general",
    })),
  });
  // Replies: structure → replan(after A, in-budget) → replan(after B, empty drains) → closing.
  const { deps, events } = makeDeps(
    [planJson(["A", "B", "C"]), inBudget, JSON.stringify({ tasks: [] }), "summary"],
    async () => "ok",
    {},
    { successfulEdits: 0, failedWrites: 1 }, // C1: force failures so the replan calls fire
  );
  await new Orchestrator(deps).run({ request: "add a nav item", prosePlan: "p", signal: ac() });
  const guard = events.find(
    (e) => e.type === "notice" && /Scope guard/.test((e.payload as { text: string }).text),
  );
  expect(guard).toBeUndefined();
});

test("build gate: passed → 'builds cleanly' notice, after the integration check", async () => {
  const order: string[] = [];
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"],
    async () => "ok",
  );
  deps.inspectProject = async () => {
    order.push("inspect");
    return [];
  };
  deps.verifyBuild = async () => {
    order.push("verify");
    return { outcome: "passed", fixRounds: 0 } satisfies BuildGateResult;
  };
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(order).toEqual(["inspect", "verify"]); // build gate runs AFTER the static check
  expect(
    events.some(
      (e) =>
        e.type === "notice" &&
        (e.payload as { text: string }).text === "Build check: project builds cleanly.",
    ),
  ).toBe(true);
});

test("build gate: fixed → reports the correction-round count", async () => {
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"],
    async () => "ok",
  );
  deps.verifyBuild = async () => ({ outcome: "fixed", fixRounds: 2 });
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(
    events.some(
      (e) =>
        e.type === "notice" &&
        (e.payload as { text: string }).text ===
          "Build check: fixed build error(s) after 2 correction round(s).",
    ),
  ).toBe(true);
});

test("build gate: failing → warn notice with the error tail", async () => {
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"],
    async () => "ok",
  );
  deps.verifyBuild = async () => ({
    outcome: "failing",
    fixRounds: 2,
    finalErrorTail: "TS2307: cannot find module '@/ui/button'",
  });
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  const n = events.find(
    (e) => e.type === "notice" && /still failing/.test((e.payload as { text: string }).text),
  );
  expect(n).toBeDefined();
  expect((n!.payload as { text: string; level: string }).level).toBe("warn");
  expect((n!.payload as { text: string }).text).toContain("@/ui/button");
});

test("build gate: dispatches a corrective worker carrying the build error tail", async () => {
  const { deps, workerPrompts } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"],
    async () => "ok",
  );
  // verifyBuild receives the orchestrator's `fix`; calling it must dispatch a worker.
  deps.verifyBuild = async (fix) => {
    await fix("BUILD ERROR: alias @/ui unresolved", new AbortController().signal);
    return { outcome: "fixed", fixRounds: 1 };
  };
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(workerPrompts).toHaveLength(2); // task A + the build-fix worker
  expect(workerPrompts[1]).toContain("does not build");
  expect(workerPrompts[1]).toContain("BUILD ERROR: alias @/ui unresolved");
});

test("build gate: null return (no build command) emits no build notice", async () => {
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"],
    async () => "ok",
  );
  deps.verifyBuild = async () => null;
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(
    events.some(
      (e) => e.type === "notice" && /Build check/.test((e.payload as { text: string }).text),
    ),
  ).toBe(false);
});

test("build gate: absent verifyBuild → no build notice, closing still emits", async () => {
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"],
    async () => "ok",
  );
  await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(
    events.some(
      (e) => e.type === "notice" && /Build check/.test((e.payload as { text: string }).text),
    ),
  ).toBe(false);
  expect(events.some((e) => e.type === "assistant_message")).toBe(true);
});

test("build gate: a throwing corrective worker still yields the failing notice and summary", async () => {
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "summary"],
    async (prompt) => {
      if (prompt.includes("does not build")) throw new Error("fixer boom");
      return "ok";
    },
  );
  deps.verifyBuild = async (fix, signal) => {
    await fix("BUILD ERR", signal); // dispatches the corrective worker, which throws
    return { outcome: "failing", fixRounds: 1, finalErrorTail: "BUILD ERR" };
  };
  const res = await new Orchestrator(deps).run({ request: "r", prosePlan: "p", signal: ac() });
  expect(res.kind).toBe("ran");
  expect(
    events.some(
      (e) => e.type === "notice" && /still failing/.test((e.payload as { text: string }).text),
    ),
  ).toBe(true);
  expect(events.some((e) => e.type === "assistant_message")).toBe(true); // closing summary still fires
});

test("marks a task failed and notes it for replan when the worker's writes all failed", async () => {
  // callModel order under run(): [0] structure → [1] replan(after A) → [2] closing.
  const { deps, events, users } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "I created the project files.", // worker prose claims success
    {},
    { successfulEdits: 0, failedWrites: 2 },
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });

  const notice = events.find(
    (e) => e.type === "notice" && (e.payload as { text: string }).text.includes("Task 1 failed"),
  );
  expect(notice).toBeDefined();
  expect((notice!.payload as { text: string }).text).toBe(
    "✗ Task 1 failed: no changes made (2 write(s) blocked/failed)",
  );
  // The replan user prompt (users[1]) must carry the deterministic note, not just the worker prose.
  expect(users[1]).toContain(
    "[orchestrator note: this task made no successful file changes; 2 structured write(s) were blocked or failed.]",
  );
});

test("a normally-finished worker cannot wave away a focused failure or grow verifier retries", async () => {
  const plan = JSON.stringify({
    brief: "brief",
    tasks: [
      {
        title: "Run focused suite",
        description: "implement and verify the seam",
        agent_type: "general",
        acceptance: ["bun test tests/ui/chrome.test.ts passes"],
      },
    ],
  });
  const { deps, events, systems } = makeDeps(
    [plan, "closing"],
    async () => "Three failures are pre-existing and unrelated, so this task is complete.",
    { finalIntegration: false },
  );
  deps.spawnWorker = async () => ({
    assistantText: "Three failures are pre-existing and unrelated, so this task is complete.",
    successfulEdits: 1,
    failedWrites: 0,
    editedPaths: ["tests/ui/chrome.test.ts"],
    verificationResults: [
      {
        key: "bash:bun test tests/ui/chrome.test.ts",
        command: "bun test tests/ui/chrome.test.ts",
        ok: false,
        detail: "2798 pass, 3 fail",
      },
    ],
  });

  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });

  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        String((event.payload as { text?: string }).text).includes(
          "verification command(s) still failing",
        ),
    ),
  ).toBe(true);
  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(0);
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        String((event.payload as { text?: string }).text).includes(
          "Deferring Run focused suite's unresolved verification evidence",
        ),
    ),
  ).toBe(true);
});

test("a broad full-suite failure is deferred to integration instead of failing a leaf task", async () => {
  const { deps, events, systems } = makeDeps(
    [planJson(["Implement focused seam"]), "closing"],
    async () => "implemented; the nested sandbox suite retains its baseline failures",
    { finalIntegration: false },
  );
  deps.spawnWorker = async () => ({
    assistantText: "implemented",
    successfulEdits: 1,
    failedWrites: 0,
    editedPaths: ["src/a.ts"],
    verificationResults: [
      {
        key: "bash:bun test",
        command: "bun test",
        ok: false,
        detail: "3 seatbelt tests fail",
        scope: "full" as const,
      },
    ],
  });

  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });

  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(0);
  expect(
    events.some(
      (event) =>
        event.type === "notice" && (event.payload as { text: string }).text === "✓ Task 1 done",
    ),
  ).toBe(true);
});

test("a focused verification-only leaf failure is deferred without growing recovery tasks", async () => {
  const plan = JSON.stringify({
    brief: "brief",
    tasks: [
      {
        title: "Implement focused seam",
        description: "implement src/a.ts",
        agent_type: "general",
        acceptance: ["bun test tests/a.test.ts passes"],
      },
    ],
  });
  const { deps, events, systems } = makeDeps(
    [plan, "closing"],
    async () => "implementation landed but its focused assertion still fails",
    { finalIntegration: false },
  );
  deps.spawnWorker = async () => ({
    assistantText: "implementation landed",
    successfulEdits: 1,
    failedWrites: 0,
    editedPaths: ["src/a.ts"],
    verificationResults: [
      {
        key: "bash:bun test tests/a.test.ts",
        command: "bun test tests/a.test.ts",
        ok: false,
        detail: "one focused assertion fails",
        scope: "focused" as const,
      },
    ],
  });

  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });

  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(0);
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        String((event.payload as { text?: string }).text).includes(
          "Deferring Implement focused seam's unresolved verification evidence",
        ),
    ),
  ).toBe(true);
});

test("identical structured baseline failure IDs clear a focused pre-existing failure", async () => {
  const plan = JSON.stringify({
    brief: "brief",
    tasks: [
      {
        title: "Verify sandbox baseline",
        description: "prove tests/sandbox failures are pre-existing",
        agent_type: "general",
        acceptance: ["bun test tests/sandbox/ has only the baseline failures"],
      },
    ],
  });
  const { deps, events, systems } = makeDeps([plan, "closing"], async () => "verified", {
    finalIntegration: false,
  });
  const ids = ["HostSandbox > denies outside writes"];
  deps.spawnWorker = async () => ({
    assistantText: "baseline compared",
    successfulEdits: 0,
    failedWrites: 0,
    editedPaths: [],
    verificationResults: [
      {
        key: "bash:bun test tests/sandbox/",
        command: "bun test tests/sandbox/",
        ok: false,
        detail: "current fail",
        scope: "focused" as const,
        baseline: false,
        failureIds: ids,
      },
      {
        key: "bash:bun test tests/sandbox/:baseline",
        command: "CLEETUS_VERIFICATION_BASELINE=1 bun test tests/sandbox/",
        ok: false,
        detail: "baseline fail",
        scope: "focused" as const,
        baseline: true,
        failureIds: ids,
      },
    ],
  });
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(0);
  expect(
    events.some(
      (event) =>
        event.type === "notice" && (event.payload as { text: string }).text === "✓ Task 1 done",
    ),
  ).toBe(true);
});

test("typecheck failures confined to another task's files do not retry the current leaf", async () => {
  const plan = JSON.stringify({
    brief: "brief",
    tasks: [
      {
        title: "Create header leaf",
        description: "create src/ui/header.tsx",
        agent_type: "general",
        acceptance: ["tests/ui/header.test.ts proves the header renders"],
      },
    ],
  });
  const { deps, systems, events } = makeDeps([plan, "closing"], async () => "header is complete", {
    finalIntegration: false,
  });
  deps.spawnWorker = async () => ({
    assistantText: "header is complete",
    successfulEdits: 1,
    failedWrites: 0,
    editedPaths: ["src/ui/header.tsx"],
    verificationResults: [
      {
        key: "bash:bun run typecheck",
        command: "bun run typecheck",
        ok: false,
        detail: "src/ui/transcript.tsx:9 TS2322 unrelated integration error",
        scope: "focused" as const,
      },
    ],
  });
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(0);
  expect(
    events.some(
      (event) =>
        event.type === "notice" && (event.payload as { text: string }).text === "✓ Task 1 done",
    ),
  ).toBe(true);
});

test("a strong recovery can clear the same verification failure by rerunning it successfully", async () => {
  const { deps, events, systems } = makeDeps(
    [planJson(["Recover focused implementation"]), "closing"],
    async () => "unused",
    { finalIntegration: false },
  );
  deps.spawnWorker = async () => ({
    assistantText: "stopped after a failing suite",
    successfulEdits: 1,
    failedWrites: 0,
    stoppedReason: "no_progress" as const,
    editedPaths: ["src/a.ts"],
    verificationResults: [
      { key: "bash:bun test", command: "bun test", ok: false, detail: "3 fail" },
    ],
  });
  deps.spawnRecoveryWorker = async () => ({
    assistantText: "fixed and verified",
    successfulEdits: 1,
    failedWrites: 0,
    editedPaths: ["src/a.ts"],
    verificationResults: [
      { key: "bash:bun test", command: "bun test", ok: true, detail: "2801 pass" },
    ],
  });

  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });

  expect(
    events.some(
      (event) =>
        event.type === "notice" && (event.payload as { text: string }).text === "✓ Task 1 done",
    ),
  ).toBe(true);
  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(0);
});

test("marks a no_progress worker failed with the not-converging note (and no generic no-changes note)", async () => {
  // callModel order under run(): [0] structure → [1] replan(after A) → [2] closing.
  const { deps, events, users } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "worker prose",
    {},
    { successfulEdits: 0, failedWrites: 1 },
    "no_progress",
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });

  const notice = events.find(
    (e) => e.type === "notice" && (e.payload as { text: string }).text.includes("Task 1 stopped"),
  );
  expect(notice).toBeDefined();
  expect((notice!.payload as { text: string }).text).toContain("not converging");

  // The replan user prompt (users[1]) must carry the not-converging note, and must NOT carry the
  // generic "made no successful file changes" note (suppressed for no_progress stops).
  expect(users[1]).toContain("not converging");
  expect(users[1]).not.toContain("made no successful file changes");
});

test.each([
  ["stream_watchdog", "model stream watchdog fired", "mechanical watchdog"],
  ["provider_error", "model provider failed after a retry", "provider failed after a retry"],
] as const)(
  "a %s stop is never a successful worker completion",
  async (reason, notice, handoff) => {
    const { deps, events, users } = makeDeps(
      [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
      async () => "stopped stream",
      { finalIntegration: false },
      { successfulEdits: 1, failedWrites: 0 },
      reason,
    );
    await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });

    expect(
      events.some(
        (event) =>
          event.type === "notice" &&
          String((event.payload as { text?: string }).text).includes(notice),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "notice" && (event.payload as { text?: string }).text === "✓ Task 1 done",
      ),
    ).toBe(false);
    expect(users[1]).toContain(handoff);
  },
);

test("logical task retry ceiling preserves failure and continues unrelated approved work", async () => {
  const { deps, systems, events } = makeDeps(
    [
      planJson(["Wire root", "Document result"]),
      planJson(["Retry: Wire root", "Document result"]),
      "closing",
    ],
    async () => "unused",
    { finalIntegration: false, recoveryEscalation: false, maxTaskAttempts: 2 },
  );
  const titles: string[] = [];
  deps.spawnWorker = async ({ title }) => {
    titles.push(title);
    if (title.includes("Wire root")) {
      return {
        assistantText: "still blocked",
        successfulEdits: 0,
        failedWrites: 0,
        stoppedReason: "no_progress" as const,
        editedPaths: [],
      };
    }
    return {
      assistantText: "documented",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: ["README.md"],
    };
  };

  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });

  expect(titles).toEqual(["Wire root", "Retry: Wire root", "Document result"]);
  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(1);
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        String((event.payload as { text?: string }).text).includes("Retry ceiling"),
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        String((event.payload as { text?: string }).text).includes("Task 3 done"),
    ),
  ).toBe(true);
});

test("a retried logical task does not receive repeated strong-model recovery passes", async () => {
  const { deps, events } = makeDeps(
    [planJson(["Wire root"]), planJson(["Retry: Wire root"]), "closing"],
    async () => "unused",
    { finalIntegration: false, recoveryEscalation: true, maxTaskAttempts: 2 },
  );
  deps.spawnWorker = async () => ({
    assistantText: "still stopped",
    successfulEdits: 0,
    failedWrites: 0,
    stoppedReason: "no_progress" as const,
    editedPaths: [],
  });
  let recoveryCalls = 0;
  deps.spawnRecoveryWorker = async () => {
    recoveryCalls++;
    return {
      assistantText: "recovery also stopped",
      successfulEdits: 0,
      failedWrites: 0,
      stoppedReason: "no_progress" as const,
      editedPaths: [],
    };
  };

  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });

  expect(recoveryCalls).toBe(1);
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        String((event.payload as { text?: string }).text).includes(
          "Skipping another strong-model recovery",
        ),
    ),
  ).toBe(true);
});

test("marks a task done when the worker made at least one successful edit", async () => {
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "worker ok",
    {},
    { successfulEdits: 1, failedWrites: 0 },
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  const done = events.find(
    (e) => e.type === "notice" && (e.payload as { text: string }).text === "✓ Task 1 done",
  );
  expect(done).toBeDefined();
});

test("does NOT replan after a successful task (C1)", async () => {
  const { deps, systems } = makeDeps(
    [planJson(["A", "B"]), "closing summary"], // structure, then closing — NO replan replies
    async () => "ok",
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  const replanCalls = systems.filter((s) => s.includes("mid-execution"));
  expect(replanCalls.length).toBe(0);
});

test("DOES replan after a failed task (C1)", async () => {
  // Single-task plan: parseStructuredPlan treats an empty `tasks: []` reply as unparseable (null),
  // so it doesn't touch `pending` — using a 2-task plan here would leave the second task pending
  // and trigger a second replan when it also fails under the global forced-failure workerCounts.
  const { deps, systems } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "worker ok",
    {},
    { successfulEdits: 0, failedWrites: 1 }, // workerFailedToProduceChanges → ok=false
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  const replanCalls = systems.filter((s) => s.includes("mid-execution"));
  expect(replanCalls.length).toBe(1); // exactly one replan, after the failed first task
});

test("workerFailedToProduceChanges: only failed-writes-with-no-edits is a failure", () => {
  expect(workerFailedToProduceChanges({ failedWrites: 2, successfulEdits: 0 })).toBe(true);
  expect(workerFailedToProduceChanges({ failedWrites: 2, successfulEdits: 1 })).toBe(false);
  expect(workerFailedToProduceChanges({ failedWrites: 0, successfulEdits: 0 })).toBe(false);
  expect(workerFailedToProduceChanges({ failedWrites: 0, successfulEdits: 3 })).toBe(false);
});

test("a token_budget worker outcome marks the task failed and feeds the replan (#155)", async () => {
  const { deps, users, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "done"],
    async () => "partial work",
  );
  deps.spawnWorker = async ({ prompt }) => {
    void prompt;
    return {
      assistantText: "partial work",
      successfulEdits: 1, // it DID edit — but still must be marked failed on a budget bail
      failedWrites: 0,
      stoppedReason: "token_budget" as const,
      editedPaths: [],
    };
  };
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  // users[1] is the replan prompt (users[0] = structure). It must include the budget note.
  expect(users[1]).toContain("billed-token cost ceiling");
  // A budget-stop notice must have been emitted (honest wording, not a generic "failed").
  const budgetNotice = events.find(
    (e) =>
      e.type === "notice" &&
      String((e.payload as { text?: string }).text).includes("billed-token cost ceiling"),
  );
  expect(budgetNotice).toBeDefined();
});

test("a token-cost stop with landed work continues the same task before replanning", async () => {
  const { deps, systems, events } = makeDeps(
    [planJson(["Build root"]), "closing"],
    async () => "unused",
    { finalIntegration: false, recoveryEscalation: false, maxTaskAttempts: 2 },
  );
  const titles: string[] = [];
  deps.spawnWorker = async ({ title }) => {
    titles.push(title);
    if (titles.length === 1) {
      return {
        assistantText: "cost stop",
        successfulEdits: 2,
        failedWrites: 0,
        stoppedReason: "token_budget" as const,
        editedPaths: ["src/root.tsx"],
        progressSummary:
          "Files changed: src/root.tsx\nWorker's last stated next step: run typecheck",
      };
    }
    return {
      assistantText: "finished",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: ["src/root.tsx"],
    };
  };
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(titles).toEqual(["Build root", "Retry: Build root"]);
  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(0);
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        String((event.payload as { text?: string }).text).includes("durable progress handoff"),
    ),
  ).toBe(true);
});

test("a loop checkpoint with landed work continues the same task before replanning", async () => {
  const { deps, systems, events } = makeDeps(
    [planJson(["Build root"]), "closing"],
    async () => "unused",
    { finalIntegration: false, recoveryEscalation: false, maxTaskAttempts: 2 },
  );
  const titles: string[] = [];
  deps.spawnWorker = async ({ title }) => {
    titles.push(title);
    if (titles.length === 1) {
      return {
        assistantText: "round checkpoint",
        successfulEdits: 2,
        failedWrites: 0,
        stoppedReason: "loop_limit" as const,
        editedPaths: ["src/root.tsx"],
        progressSummary: "Files changed: src/root.tsx\nNext: run typecheck",
      };
    }
    return {
      assistantText: "finished",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: ["src/root.tsx"],
    };
  };

  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });

  expect(titles).toEqual(["Build root", "Retry: Build root"]);
  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(0);
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        String((event.payload as { text?: string }).text).includes(
          "model/tool-round safety checkpoint",
        ),
    ),
  ).toBe(true);
});

test("a cancelled worker is never reported as a completed task", async () => {
  const { deps, events } = makeDeps(
    [planJson(["Build root"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "cancelled",
    { finalIntegration: false, recoveryEscalation: false, maxTaskAttempts: 1 },
  );
  deps.spawnWorker = async () => ({
    assistantText: "(cancelled)",
    successfulEdits: 1,
    failedWrites: 0,
    stoppedReason: "cancelled" as const,
    editedPaths: ["src/root.tsx"],
  });
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        String((event.payload as { text?: string }).text).includes("cancelled"),
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "notice" && (event.payload as { text?: string }).text === "✓ Task 1 done",
    ),
  ).toBe(false);
});

test("execute() treats a time_budget worker outcome as a failed task (C4a)", async () => {
  // worker returns time_budget → task fails → C1 replans once. Single-task plan: with two tasks
  // the empty-tasks replan reply parses to null (parseStructuredPlan rejects an empty task list),
  // leaving the second task pending and producing a second replan — not what this test isolates.
  const { deps, systems } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "stalled",
    {},
    { successfulEdits: 1, failedWrites: 0 },
    "time_budget", // NEW makeDeps arg: worker stoppedReason
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(systems.filter((s) => s.includes("mid-execution")).length).toBe(1); // failed → replan
});

test("a worker 'thrash' stop marks the task failed and triggers a replan (C4b)", async () => {
  // Single-task plan convention (see the time_budget sibling above): with two tasks the
  // empty-tasks replan reply parses to null, leaving the second task pending and producing
  // a second replan — not what this test isolates.
  const { deps, systems } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "stalled",
    {},
    { successfulEdits: 1, failedWrites: 0 },
    "thrash", // NEW makeDeps arg: worker stoppedReason
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(systems.filter((s) => s.includes("mid-execution")).length).toBe(1); // failed → replan
});

test("the thrash stop renders the command-failed notice wording (C4b)", async () => {
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "partial",
    {},
    { successfulEdits: 1, failedWrites: 0 },
    "thrash",
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  const notices = events
    .filter((e) => e.type === "notice")
    .map((e) => (e.payload as { text: string }).text);
  expect(
    notices.some((t) => /stopped: the same command failed repeatedly without converging/.test(t)),
  ).toBe(true);
});

test("a worker 'hidden_tools' stop marks the task failed and triggers a replan", async () => {
  // Single-task plan convention (see the time_budget/thrash siblings above): with two tasks the
  // empty-tasks replan reply parses to null, leaving the second task pending and producing
  // a second replan — not what this test isolates.
  const { deps, systems } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "stalled",
    {},
    { successfulEdits: 1, failedWrites: 0 },
    "hidden_tools", // NEW makeDeps arg: worker stoppedReason
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(systems.filter((s) => s.includes("mid-execution")).length).toBe(1); // failed → replan
});

test("the hidden_tools stop renders the unavailable-tools notice wording", async () => {
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "partial",
    {},
    { successfulEdits: 1, failedWrites: 0 },
    "hidden_tools",
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  const notices = events
    .filter((e) => e.type === "notice")
    .map((e) => (e.payload as { text: string }).text);
  expect(
    notices.some((t) =>
      /stopped: repeatedly called tools that are not available in this session/.test(t),
    ),
  ).toBe(true);
});

test("a worker that repeatedly stops with unfinished todos is partial and replanned", async () => {
  const { deps, events, systems } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "Stopped with unfinished todos",
    {},
    { successfulEdits: 1, failedWrites: 0 },
    "premature_completion",
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(1);
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        String((event.payload as { text?: string }).text).includes(
          "stopped before completing its own todo list",
        ),
    ),
  ).toBe(true);
});

test("run() executes a small (1-task) plan — the veto is retired", async () => {
  const { deps, workerPrompts } = makeDeps([planJson(["only-one"])], async () => "ok");
  const res = await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(res.kind).toBe("ran");
  expect(workerPrompts.length).toBe(1); // entered the execute loop
});

test("threads the cwd location anchor into structure, worker, and replan prompts", async () => {
  const { deps, systems, users, workerPrompts } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "ok",
    {},
    { successfulEdits: 0, failedWrites: 1 }, // fail A → force a replan so replanUser is exercised
  );
  deps.projectDir = "/p/ct4";
  await new Orchestrator(deps).run({
    request: "req",
    prosePlan: "plan",
    location: { kind: "cwd" },
    signal: ac(),
  });
  const anchorFragment = "Do NOT create a subdirectory";
  expect(systems[0]! + users[0]!).toContain(anchorFragment); // structuring carries it
  expect(workerPrompts[0]).toContain(anchorFragment); // worker carries it
  expect(users[1]).toContain(anchorFragment); // replan carries it (the split fix)
});

test("budget-stopped task is reported honestly, not 'no changes made' (B1)", async () => {
  const { deps, events } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "partial",
    {},
    { successfulEdits: 1, failedWrites: 0 },
    "token_budget", // worker stoppedReason (makeDeps 5th arg)
  );
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  const notices = events
    .filter((e) => e.type === "notice")
    .map((e) => (e.payload as { text: string }).text);
  expect(notices.some((t) => t.includes("billed-token cost ceiling"))).toBe(true);
  expect(notices.some((t) => t.includes("no changes made"))).toBe(false);
});

test("replan is told the target already has a scaffolded project (B2)", async () => {
  const { deps, users } = makeDeps(
    [planJson(["A"]), JSON.stringify({ tasks: [] }), "closing"],
    async () => "partial",
    {},
    { successfulEdits: 1, failedWrites: 0 },
    "token_budget",
  );
  deps.listDir = async () => ["package.json", "src", "vite.config.ts", ".cleetus"];
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(users[1]).toContain("do NOT re-scaffold"); // replan user prompt carries the snapshot
});

test("composeWorkerPrompt: first task — anchor + task + brief only, no done/upcoming/snapshot", () => {
  const p = composeWorkerPrompt({
    anchor: "ANCHOR",
    onDiskSnapshot: "",
    doneEntries: [],
    taskDescription: "scaffold it",
    upcomingTitles: ["Add router", "Build"],
    brief: "BRIEF",
  });
  expect(p).toBe(
    "ANCHOR\n\n## Your task (do ONLY this)\nscaffold it\n\n## Upcoming (NOT your job): Add router; Build\n\n## Project brief\nBRIEF",
  );
  expect(p).not.toContain("## Prior task outcomes");
});

test("composeWorkerPrompt: middle task — every section present", () => {
  const p = composeWorkerPrompt({
    anchor: "ANCHOR",
    onDiskSnapshot: "The project already exists on disk. It contains: package.json, src",
    doneEntries: [
      { title: "Scaffold", status: "done", files: [] },
      { title: "shadcn init", status: "done", files: [] },
    ],
    taskDescription: "add router",
    upcomingTitles: ["Build"],
    brief: "BRIEF",
  });
  expect(p).toBe(
    "ANCHOR\n\n## Prior task outcomes\n ✓ Scaffold\n ✓ shadcn init\nThe project already exists on disk. It contains: package.json, src\n\n## Your task (do ONLY this)\nadd router\n\n## Upcoming (NOT your job): Build\n\n## Project brief\nBRIEF",
  );
});

test("composeWorkerPrompt: last task — no upcoming section", () => {
  const p = composeWorkerPrompt({
    anchor: "ANCHOR",
    onDiskSnapshot: "The project already exists on disk. It contains: src",
    doneEntries: [{ title: "Scaffold", status: "done", files: [] }],
    taskDescription: "build it",
    upcomingTitles: [],
    brief: "BRIEF",
  });
  expect(p).not.toContain("## Upcoming");
  expect(p).toContain("## Prior task outcomes\n ✓ Scaffold");
});

test("composeWorkerPrompt: snapshot without done titles still renders the exists line", () => {
  const p = composeWorkerPrompt({
    anchor: "ANCHOR",
    onDiskSnapshot: "The project already exists on disk. It contains: src",
    doneEntries: [],
    taskDescription: "do it",
    upcomingTitles: [],
    brief: "BRIEF",
  });
  expect(p).toContain("The project already exists on disk. It contains: src");
  expect(p).not.toContain("## Prior task outcomes"); // no titles → no header, snapshot stands alone
});

test("a completed task's editedPaths become producedFiles and appear in the next digest", async () => {
  // 2-task plan, both succeed (no replan needed): structure → closing only.
  const { deps, workerPrompts } = makeDeps([planJson(["A", "B"]), "closing"], async () => "ok");
  let call = 0;
  deps.spawnWorker = async ({ prompt }) => {
    workerPrompts.push(prompt);
    call++;
    return {
      assistantText: "ok",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: call === 1 ? ["src/foo.ts"] : [],
    };
  };
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(workerPrompts).toHaveLength(2);
  // The second worker's prompt must carry task A's produced file in the "Already done" digest.
  expect(workerPrompts[1]).toContain("→ src/foo.ts");
});

test("an explore worker's findings are retained for the next context-isolated worker", async () => {
  const structured = JSON.stringify({
    brief: "brief",
    tasks: [
      {
        title: "Map exports",
        description: "inspect the existing TUI",
        agent_type: "explore",
        acceptance: ["report exact paths"],
      },
      {
        title: "Build component",
        description: "implement using the mapped exports",
        agent_type: "general",
        acceptance: ["component is wired"],
      },
    ],
  });
  const { deps, workerPrompts } = makeDeps([structured, "closing"], async () =>
    workerPrompts.length === 1
      ? "AppProps comes from src/ui/tui/app.tsx and the render site is src/bin/cleetus.ts."
      : "done",
  );

  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });

  expect(workerPrompts).toHaveLength(2);
  expect(workerPrompts[1]).toContain("Handoff:");
  expect(workerPrompts[1]).toContain("AppProps comes from src/ui/tui/app.tsx");
});

test("a stopped worker's edited paths survive as a partial outcome in the next prompt", async () => {
  const { deps, workerPrompts } = makeDeps(
    [planJson(["Wire CLI", "Build root"]), planJson(["Build root"]), "closing"],
    async () => "ok",
  );
  let call = 0;
  deps.spawnWorker = async ({ prompt }) => {
    workerPrompts.push(prompt);
    call++;
    return call === 1
      ? {
          assistantText: "stopped",
          successfulEdits: 2,
          failedWrites: 0,
          stoppedReason: "no_progress" as const,
          editedPaths: ["src/bin/cleetus.ts"],
        }
      : { assistantText: "done", successfulEdits: 1, failedWrites: 0, editedPaths: [] };
  };
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(workerPrompts[1]).toContain(
    "◐ Wire CLI → src/bin/cleetus.ts (partial — inspect before continuing)",
  );
  expect(workerPrompts[1]).not.toContain("✓ Wire CLI");
});

test("a stopped worker escalates once to the orchestrator-model worker before replanning", async () => {
  const { deps, systems } = makeDeps(
    [planJson(["Wire CLI", "Build root"]), "closing"],
    async () => "ok",
    { finalIntegration: false },
  );
  let ordinaryCalls = 0;
  deps.spawnWorker = async () => {
    ordinaryCalls++;
    return ordinaryCalls === 1
      ? {
          assistantText: "stopped",
          successfulEdits: 1,
          failedWrites: 0,
          stoppedReason: "no_progress" as const,
          editedPaths: ["src/bin/cleetus.ts"],
        }
      : { assistantText: "done", successfulEdits: 1, failedWrites: 0, editedPaths: [] };
  };
  const recoveryPrompts: string[] = [];
  deps.spawnRecoveryWorker = async ({ prompt }) => {
    recoveryPrompts.push(prompt);
    return {
      assistantText: "verified and finished",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: ["src/ui/tui/alt/App.tsx"],
    };
  };
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(recoveryPrompts).toHaveLength(1);
  expect(recoveryPrompts[0]).toContain("◐ Wire CLI → src/bin/cleetus.ts");
  expect(systems.filter((s) => s.includes("mid-execution"))).toHaveLength(0);
});

test("a stream-watchdog cycle stop enters the strong recovery path", async () => {
  const { deps, systems } = makeDeps(
    [planJson(["Extract state seam"]), "closing"],
    async () => "unused",
    { finalIntegration: false },
  );
  deps.spawnWorker = async () => ({
    assistantText: "stopped: exact long reasoning cycle",
    successfulEdits: 0,
    failedWrites: 0,
    stoppedReason: "stream_watchdog" as const,
    editedPaths: [],
    progressSummary: "No files changed; inspected src/ui/tui/app.tsx",
  });
  const recoveryPrompts: string[] = [];
  deps.spawnRecoveryWorker = async ({ prompt }) => {
    recoveryPrompts.push(prompt);
    return {
      assistantText: "implemented the state seam",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: ["src/ui/tui/tui-state.ts"],
    };
  };
  await new Orchestrator(deps).run({ request: "req", prosePlan: "plan", signal: ac() });
  expect(recoveryPrompts).toHaveLength(1);
  expect(recoveryPrompts[0]).toContain("No files changed; inspected src/ui/tui/app.tsx");
  expect(systems.filter((system) => system.includes("mid-execution"))).toHaveLength(0);
});

test("multi-task execution ends with a review-capable evidence-backed semantic verifier", async () => {
  const { deps, events } = makeDeps(
    [planJson(["Leaf A", "Leaf B"]), "closing"],
    async () => "done",
  );
  const strongPrompts: string[] = [];
  const strongTypes: string[] = [];
  deps.spawnRecoveryWorker = async ({ prompt, type }) => {
    strongPrompts.push(prompt);
    strongTypes.push(type);
    return {
      assistantText: semanticJson("pass"),
      successfulEdits: 0,
      failedWrites: 0,
      editedPaths: [],
    };
  };
  const result = await new Orchestrator(deps).run({
    request: "build the alternate UI",
    prosePlan: "approved split-pane plan",
    signal: ac(),
  });
  expect(strongPrompts).toHaveLength(1);
  expect(strongTypes).toEqual(["review"]);
  expect(strongPrompts[0]).toContain("Act as an acceptance verifier");
  expect(strongPrompts[0]).toContain("Account for EVERY acceptance criterion");
  expect(strongPrompts[0]).toContain("--help or --version is not smoke evidence");
  expect(strongPrompts[0]).toContain("unexpected config, manifest, lockfile, loader");
  expect(strongPrompts[0]).toContain("advertised controls/keybindings have real handlers");
  expect(strongPrompts[0]).toContain("build the alternate UI");
  expect(strongPrompts[0]).toContain("approved split-pane plan");
  expect(result).toEqual({ kind: "ran", complete: true });
  expect(
    events.some(
      (e) =>
        e.type === "notice" &&
        /Semantic acceptance passed with repository evidence/.test(
          String((e.payload as { text?: string }).text),
        ),
    ),
  ).toBe(true);
});

test("semantic verifier retries malformed evidence once before deciding", async () => {
  const { deps, events } = makeDeps(
    [planJson(["Leaf A", "Wire root"]), "closing"],
    async () => "done",
  );
  let verifierCalls = 0;
  deps.spawnRecoveryWorker = async ({ prompt }) => {
    if (prompt.includes("Act as an acceptance verifier")) {
      verifierCalls++;
      return {
        assistantText: verifierCalls === 1 ? '{"verdict":"fail","checks":[' : semanticJson("pass"),
        successfulEdits: 0,
        failedWrites: 0,
        editedPaths: [],
      };
    }
    throw new Error("no repair expected");
  };

  const result = await new Orchestrator(deps).run({
    request: "build a wired feature",
    prosePlan: "Implement and wire the feature.",
    signal: ac(),
  });

  expect(verifierCalls).toBe(2);
  expect(result).toEqual({ kind: "ran", complete: true });
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        String((event.payload as { text?: string }).text).includes(
          "Semantic verifier returned invalid evidence; retrying once",
        ),
    ),
  ).toBe(true);
});

test("a verifier's failed command deterministically overrides its claimed pass verdict", async () => {
  const { deps } = makeDeps([planJson(["Build UI", "Wire UI"]), "closing"], async () => "done");
  let verifierCalls = 0;
  let repairCalls = 0;
  deps.spawnRecoveryWorker = async ({ prompt }) => {
    if (prompt.includes("Act as an acceptance verifier")) {
      verifierCalls++;
      return {
        assistantText: semanticJson("pass"),
        successfulEdits: 0,
        failedWrites: 0,
        editedPaths: [],
        verificationResults:
          verifierCalls === 1
            ? [
                {
                  key: "bash:bun run lint",
                  command: "bun run lint",
                  ok: false,
                  detail: "5 formatting errors",
                },
              ]
            : [],
      };
    }
    repairCalls++;
    expect(prompt).toContain("Verification command passes: bun run lint");
    return {
      assistantText: "formatted the files and reran lint",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: ["src/ui/alt-app.tsx"],
      verificationResults: [
        { key: "bash:bun run lint", command: "bun run lint", ok: true, detail: "clean" },
      ],
    };
  };

  const result = await new Orchestrator(deps).run({
    request: "build the alternate UI",
    prosePlan: "Implement, wire, lint, and test the UI.",
    signal: ac(),
  });

  expect(verifierCalls).toBe(2);
  expect(repairCalls).toBe(1);
  expect(result).toEqual({ kind: "ran", complete: true });
});

test("host-run quality gates cannot be omitted by a passing semantic verifier", async () => {
  const { deps } = makeDeps([planJson(["Build UI", "Wire UI"]), "closing"], async () => "done");
  let verifierCalls = 0;
  let repairCalls = 0;
  let qualityCalls = 0;
  deps.spawnRecoveryWorker = async ({ prompt }) => {
    if (prompt.includes("Act as an acceptance verifier")) {
      verifierCalls++;
      return {
        assistantText: semanticJson("pass"),
        successfulEdits: 0,
        failedWrites: 0,
        editedPaths: [],
      };
    }
    repairCalls++;
    expect(prompt).toContain("Verification command passes: bun run lint");
    return {
      assistantText: "formatted the changed files",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: ["src/ui/alt-app.tsx"],
    };
  };
  deps.verifyQuality = async () => {
    qualityCalls++;
    return [
      {
        key: "bash:bun run lint",
        command: "bun run lint",
        ok: qualityCalls > 1,
        detail: qualityCalls > 1 ? "clean" : "8 formatting errors",
        scope: "full",
      },
    ];
  };

  const result = await new Orchestrator(deps).run({
    request: "build the alternate UI",
    prosePlan: "Implement, render, lint, and test the UI.",
    signal: ac(),
  });

  expect(verifierCalls).toBe(2);
  expect(qualityCalls).toBe(2);
  expect(repairCalls).toBe(1);
  expect(result).toEqual({ kind: "ran", complete: true });
});

test("a post-build semantic failure uses an otherwise-unused repair and rebuilds", async () => {
  const { deps } = makeDeps(
    [planJson(["Build leaves", "Wire entry point"]), "closing"],
    async () => "done",
  );
  let verifierCalls = 0;
  let semanticRepairCalls = 0;
  deps.spawnRecoveryWorker = async ({ prompt }) => {
    if (prompt.includes("Act as an acceptance verifier")) {
      verifierCalls++;
      const verdict = verifierCalls === 2 ? "fail" : "pass";
      return {
        assistantText: semanticJson(verdict, "The entry point renders the requested feature"),
        successfulEdits: 0,
        failedWrites: 0,
        editedPaths: [],
      };
    }
    if (prompt.includes("project does not build")) {
      return {
        assistantText: "Mechanical fix landed.",
        successfulEdits: 1,
        failedWrites: 0,
        editedPaths: ["src/entry.ts"],
      };
    }
    if (prompt.includes("Repair ONLY the failed acceptance checks")) {
      semanticRepairCalls++;
      return {
        assistantText: "Wired the real feature.",
        successfulEdits: 1,
        failedWrites: 0,
        editedPaths: ["src/entry.ts", "src/feature.ts"],
      };
    }
    throw new Error("unexpected strong worker");
  };
  let buildGateCalls = 0;
  deps.verifyBuild = async (fix, signal) => {
    buildGateCalls++;
    if (buildGateCalls === 1) {
      await fix("entry module missing", signal);
      return { outcome: "fixed", fixRounds: 1 };
    }
    return { outcome: "passed", fixRounds: 0 };
  };

  const result = await new Orchestrator(deps).run({
    request: "build and wire the feature",
    prosePlan: "The entry point must render the real implementation.",
    signal: ac(),
  });

  expect(verifierCalls).toBe(3); // pre-build pass → post-build fail → post-repair pass
  expect(semanticRepairCalls).toBe(1);
  expect(buildGateCalls).toBe(2); // semantic repair happened after the first build
  expect(result).toEqual({ kind: "ran", complete: true });
});

test("compile-only build repair cannot override failed semantic acceptance", async () => {
  const { deps, recorded } = makeDeps(
    [planJson(["Build alt leaves", "Wire alt root"]), "closing"],
    async () => "done",
  );
  const strongPrompts: string[] = [];
  let verifyCalls = 0;
  deps.spawnRecoveryWorker = async ({ prompt }) => {
    strongPrompts.push(prompt);
    if (prompt.includes("Act as an acceptance verifier")) {
      verifyCalls++;
      return {
        assistantText: semanticJson("fail", "The alternate root renders the alternate components"),
        successfulEdits: 0,
        failedWrites: 0,
        editedPaths: [],
      };
    }
    if (prompt.includes("project does not build")) {
      return {
        assistantText: "Added a pass-through export so compilation succeeds.",
        successfulEdits: 1,
        failedWrites: 0,
        editedPaths: ["src/ui/tui/alt/app.tsx"],
      };
    }
    return {
      assistantText: "Repair attempted.",
      successfulEdits: 1,
      failedWrites: 0,
      editedPaths: ["src/ui/tui/alt/app.tsx"],
    };
  };
  deps.verifyBuild = async (fix, signal) => {
    await fix("Could not resolve src/ui/tui/alt/app", signal);
    return { outcome: "fixed", fixRounds: 1 };
  };

  const result = await new Orchestrator(deps).run({
    request: "add a distinct alternate TUI",
    prosePlan: "Compose the alternate root from the alternate leaf components.",
    signal: ac(),
  });

  expect(verifyCalls).toBe(2); // initial evidence → repair/build edits → final evidence
  const buildPrompt = strongPrompts.find((prompt) => prompt.includes("project does not build"));
  expect(buildPrompt).toContain("Do NOT replace requested behavior with a stub");
  expect(buildPrompt).toContain("pass-through/re-export of an old implementation");
  expect(result).toEqual({ kind: "ran", complete: false });
  expect(recorded.at(-1)).toContain(
    "✗ Verify the approved plan against the final repository — incomplete",
  );
  expect(recorded.at(-1)).toContain("Final result: incomplete. Semantic acceptance did not pass.");
  expect(recorded.at(-1)).not.toContain("largely in place");
});

test("first worker scaffolds a fresh dir; later worker gets progress digest, no scaffold clause", async () => {
  const { deps, workerPrompts } = makeDeps(
    [planJson(["Scaffold app", "Add router"]), "all done"], // structure reply, then closing reply
    async () => "ok",
  );
  let calls = 0;
  // Fresh on the first read (task 1), populated afterwards (task 2 + any post-loop reads).
  deps.listDir = async () => (calls++ === 0 ? [] : ["package.json", "src", "node_modules"]);

  await new Orchestrator(deps).run({ request: "build an app", prosePlan: "", signal: ac() });

  expect(workerPrompts).toHaveLength(2);
  // Task 1: fresh dir → scaffold clause present; no "already done"; upcoming names task 2.
  expect(workerPrompts[0]).toContain("handles the non-empty-cwd case"); // cwd scaffold clause
  expect(workerPrompts[0]).not.toContain("## Prior task outcomes");
  expect(workerPrompts[0]).toContain("## Upcoming (NOT your job): Add router");
  // Task 2: project exists → digest + snapshot; NO scaffold clause.
  expect(workerPrompts[1]).toContain("## Prior task outcomes\n ✓ Scaffold app");
  expect(workerPrompts[1]).toContain("The project already exists on disk. It contains:");
  expect(workerPrompts[1]).not.toContain("handles the non-empty-cwd case");
});
