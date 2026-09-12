import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowCreatorController } from "../../src/workflows/creator/controller";
import { WorkflowDraftStore } from "../../src/workflows/creator/draft-store";
import type { WorkflowDraftRecord } from "../../src/workflows/creator/types";
import { WorkflowCommandController } from "../../src/workflows/interactive-controller";
import type { WorkflowManifest } from "../../src/workflows/parse";

function draft(phase: "questions" | "draft"): WorkflowDraftRecord {
  return {
    id: "01K00000000000000000000000",
    scope: "project",
    name: phase === "draft" ? "weather" : undefined,
    phase,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    messages: [],
    diagnostics: [],
    output:
      phase === "draft"
        ? {
            response: "Draft ready.",
            phase: "draft",
            assumptions: [],
            unresolvedQuestions: [],
            manifest: {
              schema_version: 1,
              name: "weather",
              revision: 1,
              description: "Summarize weather.",
              inputs: { type: "object", properties: {} },
              secrets: {},
              permissions: {},
              execution: { timeout: "1m" },
              steps: [{ id: "render", uses: "text.template@1", with: { template: "ok" } }],
              outputs: {
                markdown: { value: "$steps.render.output.text", schema: { type: "string" } },
              },
            },
          }
        : {
            response: "What is the purpose of the workflow?",
            phase: "questions",
            assumptions: [],
            unresolvedQuestions: ["purpose"],
          },
  };
}

describe("interactive workflow creation", () => {
  test("treats a name-only create command as requirements-free and does not call the model", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-interactive-")));
    let calls = 0;
    let receivedMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const creator = new WorkflowCreatorController(
      store,
      {
        async respond(input) {
          calls++;
          receivedMessages = [...input.messages];
          return {
            response: "What fields should the brief contain?",
            phase: "questions",
            assumptions: [],
            unresolvedQuestions: ["What fields should the brief contain?"],
          };
        },
      },
      "Interview.",
      {} as never,
    );
    const output: string[] = [];
    const controller = new WorkflowCommandController({} as never, {
      creator,
      activate: () => ({ activeDir: "" }),
    });

    await controller.handle("create ghget", {
      sessionId: "session-one",
      print: (value) => output.push(value),
    });

    expect(calls).toBe(0);
    expect(output.at(-1)).toContain("What should `ghget` do");
    expect(output.at(-1)).toContain("what should it return or display");
    expect(output.at(-1)?.toLowerCase()).not.toContain("github");
    expect(creator.latest("session-one")?.messages).toEqual([]);

    await controller.handleNatural(
      "Fetch public GitHub repository metadata and display a concise Markdown brief.",
      {
        sessionId: "session-one",
        print: (value) => output.push(value),
      },
    );

    expect(calls).toBe(1);
    expect(receivedMessages).toEqual([
      {
        role: "user",
        content: "Fetch public GitHub repository metadata and display a concise Markdown brief.",
      },
    ]);
  });

  test("uses the active definition as the immutable base and keeps archived failures diagnostic", async () => {
    const currentManifest = {
      ...draft("draft").output!.manifest!,
      revision: 2,
      description: "Fetch from a placeholder weather service.",
      steps: [
        {
          id: "fetch",
          uses: "http.request@1",
          with: { url: "https://api.weather.example.com/current" },
        },
      ],
    } as WorkflowManifest;
    const failedManifest = {
      ...draft("draft").output!.manifest!,
      revision: 1,
      description: "Fetch the Wilmette forecast and summarize it.",
      steps: [
        {
          id: "fetch",
          uses: "http.request@1",
          with: { url: "https://api.open-meteo.com/v1/forecast" },
        },
        {
          id: "summarize",
          uses: "llm.generate@1",
          with: {
            prompt: "Summarize in four bullets.",
            input: "$steps.fetch.output",
            output_schema: { type: "array", items: { type: "string" } },
            max_output_tokens: 500,
          },
        },
      ],
    } as WorkflowManifest;
    const pkg = (manifest: WorkflowManifest) => ({
      name: "weather",
      description: manifest.description,
      source: "project" as const,
      dir: "/project/.cleetus/workflows/weather",
      manifestPath: "/project/.cleetus/workflows/weather/workflow.yaml",
      manifest,
      files: [
        {
          path: "tests/existing.yaml",
          content: JSON.stringify({
            schema_version: 1,
            name: "existing regression",
            mode: "mock",
            inputs: {},
            mocks: {},
            expect: { status: "succeeded" },
          }),
        },
      ],
      runtimeResources: [],
      packageHash: "package",
      executionHash: "execution",
    });
    let creatorInput = "";
    let creatorScope = "";
    let initialMessages: WorkflowDraftRecord["messages"] = [];
    let initialQuestions: string[] = [];
    let targetRevision: number | undefined;
    let baseResources: WorkflowDraftRecord["baseResources"] = [];
    let current = draft("questions");
    const controller = new WorkflowCommandController(
      {
        show: () => pkg(currentManifest),
        history: () => [
          {
            id: "run-one",
            workflowName: "weather",
            revision: 1,
            packageHash: "old-package",
            executionHash: "old-execution",
            status: "failed",
            workspace: "/project",
            inputs: {},
            createdAt: 1,
            error: { code: "output_truncated", message: "model output was truncated" },
          },
        ],
        showRevision: (_name: string, revision: number) =>
          revision === 1 ? pkg(failedManifest) : undefined,
      } as never,
      {
        creator: {
          start(input: {
            scope: string;
            targetRevision?: number;
            initialMessages?: WorkflowDraftRecord["messages"];
            initialQuestions?: string[];
            baseResources?: WorkflowDraftRecord["baseResources"];
          }) {
            creatorScope = input.scope;
            targetRevision = input.targetRevision;
            initialMessages = input.initialMessages ?? [];
            initialQuestions = input.initialQuestions ?? [];
            baseResources = input.baseResources ?? [];
            current = {
              ...current,
              messages: [...initialMessages],
              output: {
                response: "Workflow requirements are still incomplete.",
                phase: "questions",
                assumptions: [],
                unresolvedQuestions: [...initialQuestions],
              },
            };
            return current;
          },
          async respond(_id: string, input: string) {
            creatorInput = input;
            return current;
          },
          get: () => current,
          latest: () => current,
        } as never,
        activate: () => ({ activeDir: "" }),
      },
    );

    const output: string[] = [];
    await controller.handle("create weather", { print: (value) => output.push(value) });

    expect(creatorScope).toBe("project");
    expect(targetRevision).toBe(3);
    expect(creatorInput).toBe("");
    expect(initialQuestions).toEqual([
      "What would you like to change in `weather`? Its active definition and latest run are already loaded as context.",
    ]);
    expect(output.at(-1)).toContain("What would you like to change in `weather`?");
    expect(initialMessages).toHaveLength(1);
    expect(initialMessages[0]?.content).toContain("Revise the existing workflow 'weather'");
    expect(initialMessages[0]?.content).toContain("currently activated revision 2");
    expect(initialMessages[0]?.content).toContain(
      "Archived revisions and run history are diagnostic context only",
    );
    expect(initialMessages[0]?.content).toContain("api.weather.example.com");
    expect(initialMessages[0]?.content).not.toContain('"max_output_tokens": 500');
    expect(initialMessages[0]?.content).toContain("omit provider and model");
    expect(initialMessages[0]?.content).toContain("tests/existing.yaml");
    expect(initialMessages[0]?.content).toContain(
      "Run history is diagnostic background, not authorization",
    );
    expect(baseResources).toEqual([
      {
        path: "tests/existing.yaml",
        content: expect.stringContaining("existing regression"),
      },
    ]);
    expect(initialMessages[0]?.content).not.toContain("api.open-meteo.com");

    await controller.handleNatural("Keep the behavior but fix the latest failed run.", {
      print() {},
    });
    expect(creatorInput).toBe("Keep the behavior but fix the latest failed run.");
  });

  test("surfaces unresolved questions and says activation is blocked", async () => {
    const current = {
      ...draft("questions"),
      name: "weather",
      output: {
        response: "Draft created.",
        phase: "draft" as const,
        assumptions: [],
        unresolvedQuestions: ["Which weather API should be used?", "Is an API key required?"],
      },
    };
    const controller = new WorkflowCommandController({} as never, {
      creator: { latest: () => current, get: () => current } as never,
      activate: () => ({ activeDir: "" }),
    });
    const output: string[] = [];

    await controller.handle("status", {
      print: (value) => output.push(value),
    });

    expect(output.at(-1)).toContain("Which weather API should be used?");
    expect(output.at(-1)).toContain("Is an API key required?");
    expect(output.at(-1)).toContain("Activation is blocked");
    expect(output.at(-1)).toContain("Workflow requirements are still incomplete.");
    expect(output.at(-1)).not.toContain("Draft created.");
  });

  test("diagnoses an LLM cancellation at the declared deadline as a step timeout", async () => {
    const manifest = {
      ...draft("draft").output!.manifest!,
      revision: 3,
      steps: [
        {
          id: "summarize-weather",
          uses: "llm.generate@1",
          timeout: "30s",
          with: {
            prompt: "Summarize.",
            input: {},
            output_schema: { type: "array" },
          },
        },
      ],
    } as WorkflowManifest;
    const workflowPackage = {
      name: "weather",
      description: manifest.description,
      source: "project" as const,
      dir: "/project/.cleetus/workflows/weather",
      manifestPath: "/project/.cleetus/workflows/weather/workflow.yaml",
      manifest,
      files: [],
      runtimeResources: [],
      packageHash: "package",
      executionHash: "execution",
    };
    let creatorInput = "";
    let initialMessages: WorkflowDraftRecord["messages"] = [];
    const current = draft("questions");
    const controller = new WorkflowCommandController(
      {
        show: () => workflowPackage,
        history: () => [
          {
            id: "run-timeout",
            workflowName: "weather",
            revision: 3,
            packageHash: "package",
            executionHash: "execution",
            status: "failed",
            workspace: "/project",
            inputs: {},
            createdAt: 1,
            error: { code: "cancelled", message: "model call cancelled" },
          },
        ],
        runSteps: () => [
          {
            runId: "run-timeout",
            stepId: "summarize-weather",
            ordinal: 0,
            uses: "llm.generate@1",
            effect: "read-only",
            status: "failed",
            attempts: 1,
            error: { code: "cancelled", message: "model call cancelled" },
            startedAt: 10_000,
            endedAt: 40_003,
          },
        ],
      } as never,
      {
        creator: {
          start(input: { initialMessages?: WorkflowDraftRecord["messages"] }) {
            initialMessages = input.initialMessages ?? [];
            return current;
          },
          async respond(_id: string, input: string) {
            creatorInput = input;
            return current;
          },
          get: () => current,
          latest: () => current,
        } as never,
        activate: () => ({ activeDir: "" }),
      },
    );

    await controller.handle("create weather", { print() {} });

    expect(creatorInput).toBe("");
    expect(initialMessages[0]?.content).toContain(
      "was aborted by its declared 30s timeout after 30003ms",
    );
    expect(initialMessages[0]?.content).toContain(
      "Treat this as a timeout, not a user cancellation",
    );
    expect(initialMessages[0]?.content).toContain("2-minute default step timeout");

    await controller.handleNatural("Fix the timeout without changing the workflow purpose.", {
      print() {},
    });
    expect(creatorInput).toBe("Fix the timeout without changing the workflow purpose.");
  });

  test("routes narrow natural intent, reviews, and activates without running", async () => {
    let current = draft("questions");
    let activated = 0;
    let started = false;
    const creator = {
      start: (input: { initialQuestions?: string[] }) => {
        started = true;
        current = {
          ...current,
          output: {
            response: "Workflow requirements are still incomplete.",
            phase: "questions" as const,
            assumptions: [],
            unresolvedQuestions: input.initialQuestions ?? [],
          },
        };
        return current;
      },
      respond: async () => {
        current = current.phase === "questions" ? draft("draft") : current;
        return current;
      },
      get: () => current,
      latest: () => (started ? current : undefined),
      markActivated() {},
      discard() {},
    };
    const controller = new WorkflowCommandController({} as never, {
      creator: creator as never,
      activate() {
        activated += 1;
        return { activeDir: "/project/.cleetus/workflows/weather" };
      },
    });
    const output: string[] = [];
    const recordedInputs: string[] = [];
    expect(
      await controller.handleNatural("Create a workflow", {
        sessionId: "one",
        print: (value) => output.push(value),
        recordInput: (value) => recordedInputs.push(value),
      }),
    ).toBe(true);
    expect(output.join("\n")).toContain("What would you like the workflow to be named?");
    expect(activated).toBe(0);
    await controller.handleNatural("Name it weather and summarize the local forecast.", {
      sessionId: "one",
      print: (value) => output.push(value),
      recordInput: (value) => recordedInputs.push(value),
    });
    expect(output.join("\n")).toContain("Reply 'activate'");
    expect(activated).toBe(0);
    await controller.handleNatural("activate", {
      sessionId: "one",
      print: (value) => output.push(value),
      recordInput: (value) => recordedInputs.push(value),
    });
    expect(activated).toBe(1);
    expect(output.at(-1)).toContain("It has not been run");
    expect(recordedInputs).toEqual([
      "Create a workflow",
      "Name it weather and summarize the local forecast.",
      "activate",
    ]);
  });

  test("blocks the old active workflow while its reviewed replacement awaits confirmation", async () => {
    const current = {
      ...draft("draft"),
      targetRevision: 2,
      output: {
        ...draft("draft").output!,
        manifest: {
          ...draft("draft").output!.manifest!,
          revision: 2,
        },
      },
    };
    const activations: Array<boolean | undefined> = [];
    const runs: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const output: string[] = [];
    const controller = new WorkflowCommandController(
      {
        async run(input: { name: string }) {
          runs.push(input.name);
          return {
            run_id: `run-${input.name}`,
            workflow: input.name,
            revision: 1,
            execution_hash: "active",
            status: "succeeded",
            outputs: { result: "ok" },
          };
        },
        show(name: string) {
          return {
            manifest: {
              inputs: {},
              presentation: { output: "result" },
            },
            name,
          };
        },
      } as never,
      {
        creator: {
          get: () => current,
          latest: () => current,
          markActivated() {},
        } as never,
        activate(_draft, replace) {
          activations.push(replace);
          if (!replace) throw new Error("replacement requires explicit approval");
          return { activeDir: "/project/.cleetus/workflows/weather" };
        },
        record(_context, _type, payload) {
          events.push(payload);
        },
      },
    );
    const context = {
      sessionId: "replacement-session",
      print: (value: string) => output.push(value),
    };

    await controller.handle("run weather", context);

    expect(runs).toEqual([]);
    expect(output.at(-1)).toContain("valid replacement revision 2");
    expect(output.at(-1)).toContain("Reply 'activate'");
    expect(events.at(-1)).toMatchObject({
      kind: "workflow_replacement_run_blocked",
      workflow: "weather",
      pendingRevision: 2,
      stage: "valid_draft",
    });

    await controller.handleNatural("activate", context);
    await controller.handle("run weather", context);

    expect(runs).toEqual([]);
    expect(output.at(-1)).toContain("replacement revision 2 awaiting confirmation");
    expect(output.at(-1)).toContain("currently active revision was not run");
    expect(output.at(-1)).toContain("Reply exactly 'replace'");
    expect(output.at(-1)).toContain("'cancel'");
    expect(events.at(-1)).toMatchObject({
      kind: "workflow_replacement_run_blocked",
      workflow: "weather",
      pendingRevision: 2,
      stage: "replacement_confirmation",
    });

    await controller.handle("run other {}", context);
    expect(runs).toEqual(["other"]);

    await controller.handleNatural("replace", context);
    expect(activations).toEqual([undefined, true]);
    expect(output.at(-1)).toContain("Replaced workflow 'weather'");
    expect(runs).toEqual(["other"]);
  });

  test("allows the active revision while replacement requirements are incomplete or invalid", async () => {
    let current = {
      ...draft("questions"),
      name: "weather",
      targetRevision: 2,
    };
    const runs: string[] = [];
    const controller = new WorkflowCommandController(
      {
        async run(input: { name: string }) {
          runs.push(input.name);
          return {
            run_id: `run-${runs.length}`,
            workflow: input.name,
            revision: 1,
            execution_hash: "active",
            status: "succeeded",
            outputs: { result: "active" },
          };
        },
        show() {
          return {
            manifest: { inputs: {}, presentation: { output: "result" } },
          };
        },
      } as never,
      {
        creator: {
          get: () => current,
          latest: () => current,
        } as never,
        activate: () => ({ activeDir: "" }),
      },
    );
    const context = { sessionId: "incomplete-draft", print() {} };

    await controller.handle("run weather", context);
    current = {
      ...draft("draft"),
      name: "weather",
      targetRevision: 2,
      diagnostics: [{ path: "tests", message: "invalid" }],
    };
    await controller.handle("run weather", context);

    expect(runs).toEqual(["weather", "weather"]);
  });

  test("cancelling a pending replacement preserves the old active workflow without running it", async () => {
    const current = {
      ...draft("draft"),
      targetRevision: 2,
      output: {
        ...draft("draft").output!,
        manifest: {
          ...draft("draft").output!.manifest!,
          revision: 2,
        },
      },
    };
    let discarded = 0;
    let replaced = 0;
    let runs = 0;
    const output: string[] = [];
    const controller = new WorkflowCommandController(
      {
        async run() {
          runs++;
          throw new Error("the old revision must not run");
        },
      } as never,
      {
        creator: {
          get: () => current,
          latest: () => current,
          discard() {
            discarded++;
          },
        } as never,
        activate(_draft, replace) {
          if (replace) replaced++;
          throw new Error("replacement requires explicit approval");
        },
      },
    );
    const context = {
      sessionId: "cancel-session",
      print: (value: string) => output.push(value),
    };

    await controller.handleNatural("activate", context);
    await controller.handle("run weather", context);
    await controller.handleNatural("cancel", context);

    expect(runs).toBe(0);
    expect(replaced).toBe(0);
    expect(discarded).toBe(1);
    expect(output.at(-1)).toBe("Workflow draft discarded. Nothing was activated or run.");
  });

  test("does not intercept unrelated prose", async () => {
    const controller = new WorkflowCommandController({} as never, {
      creator: { latest: () => undefined } as never,
      activate: () => ({ activeDir: "" }),
    });
    expect(
      await controller.handleNatural("Can you explain this workflow?", {
        print() {},
      }),
    ).toBe(false);
  });

  test("recovers a persisted failed draft and preserves explicit global scope", async () => {
    let current: WorkflowDraftRecord = {
      ...draft("questions"),
      sessionId: "one",
      phase: "failed",
      lastError: "request cancelled",
    };
    let startedScope: string | undefined;
    const creator = {
      start(input: { scope: "project" | "global" }) {
        startedScope = input.scope;
        current = { ...draft("questions"), scope: input.scope };
        return current;
      },
      async respond() {
        return current;
      },
      async retry() {
        current = draft("questions");
        return current;
      },
      get: () => current,
      latest: () => current,
      markActivated() {},
      discard() {},
    };
    const controller = new WorkflowCommandController({} as never, {
      creator: creator as never,
      activate: () => ({ activeDir: "" }),
    });
    const output: string[] = [];

    await controller.handle("status", {
      sessionId: "one",
      print: (value) => output.push(value),
    });
    expect(output.at(-1)).toContain("request cancelled");
    await controller.handle("retry", {
      sessionId: "one",
      print: (value) => output.push(value),
    });
    expect(output.at(-1)).toContain("purpose");

    creator.latest = () => undefined as never;
    await controller.handle('create --global "weather"', {
      sessionId: "two",
      print: (value) => output.push(value),
    });
    expect(startedScope).toBe("global");
  });

  test("shows a provider failure after requirements and recovers it after a controller restart", async () => {
    const creator = new WorkflowCreatorController(
      new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-interactive-"))),
      {
        async respond() {
          throw new Error("creator request was cancelled");
        },
      },
      "Interview.",
      {} as never,
    );
    const host = {
      creator,
      activate: () => ({ activeDir: "" }),
    };
    const output: string[] = [];
    const controller = new WorkflowCommandController({} as never, host);

    expect(
      await controller.handleNatural('Create a workflow called "weather"', {
        sessionId: "session-one",
        print: (value) => output.push(value),
      }),
    ).toBe(true);
    expect(output.at(-1)).toContain("What should `weather` do");
    await controller.handleNatural("Fetch and summarize the local forecast.", {
      sessionId: "session-one",
      print: (value) => output.push(value),
    });
    expect(output.at(-1)).toContain("creator request was cancelled");
    expect(output.at(-1)).toContain("/workflow retry");

    const restarted = new WorkflowCommandController({} as never, host);
    await restarted.handle("status", {
      sessionId: "session-one",
      print: (value) => output.push(value),
    });
    expect(output.at(-1)).toContain("attempted message were saved");
    expect(creator.latest("session-one")?.messages[0]?.content).toBe(
      "Fetch and summarize the local forecast.",
    );
  });

  test("explains actionable choices when technical validation still fails", async () => {
    const current = {
      ...draft("draft"),
      diagnostics: [{ path: "steps.1.with/", message: "must have required property 'input'" }],
    };
    const controller = new WorkflowCommandController({} as never, {
      creator: {
        latest: () => current,
        get: () => current,
      } as never,
      activate: () => ({ activeDir: "" }),
    });
    const output: string[] = [];

    await controller.handle("status", {
      sessionId: "one",
      print: (value) => output.push(value),
    });

    expect(output.at(-1)).toContain("automatic repair attempt");
    expect(output.at(-1)).toContain("Reply 'retry'");
    expect(output.at(-1)).toContain("describe what you want changed");
    expect(output.at(-1)).toContain("/workflow discard");
  });
});
