import { describe, expect, test } from "bun:test";
import { WorkflowCommandController } from "../../src/workflows/interactive-controller";

describe("WorkflowCommandController", () => {
  test("opens managed workflow drafts and keeps review, publish, and discard in the TUI", async () => {
    const calls: string[] = [];
    const controller = new WorkflowCommandController({} as never, undefined, {
      open(name, scope) {
        calls.push(`open:${name}:${scope ?? "active"}`);
        return {
          packageDir: `/project/.cleetus/workflows/.manual-drafts/${name}/package/${name}`,
          created: true,
          scope: "project",
        };
      },
      async review(name, scope) {
        calls.push(`review:${name}:${scope ?? "active"}`);
        return `reviewed ${name}`;
      },
      async publish(name, scope) {
        calls.push(`publish:${name}:${scope ?? "active"}`);
        return `published ${name}`;
      },
      discard(name, scope) {
        calls.push(`discard:${name}:${scope ?? "active"}`);
        return `discarded ${name}`;
      },
    });
    const printed: string[] = [];
    const context = {
      print: (value: string) => printed.push(value),
      openEditor: async ({ targets }: { targets: string[] }) => {
        calls.push(`edit:${targets.join(",")}`);
      },
    };

    await controller.handle("edit weather-fetch", context);
    await controller.handle("review weather-fetch", context);
    await controller.handle("publish weather-fetch", context);
    await controller.handle("discard weather-fetch", context);

    expect(calls).toEqual([
      "open:weather-fetch:active",
      "edit:/project/.cleetus/workflows/.manual-drafts/weather-fetch/package/weather-fetch",
      "review:weather-fetch:project",
      "review:weather-fetch:active",
      "publish:weather-fetch:active",
      "discard:weather-fetch:active",
    ]);
    expect(printed.join("\n")).toContain("Created isolated project workflow draft");
    expect(printed).toContain("reviewed weather-fetch");
    expect(printed).toContain("published weather-fetch");
    expect(printed).toContain("discarded weather-fetch");
  });

  test("rejects traversal-shaped manual workflow names before opening a draft", async () => {
    let opened = false;
    const controller = new WorkflowCommandController({} as never, undefined, {
      open() {
        opened = true;
        throw new Error("must not open");
      },
      async review() {
        return "";
      },
      async publish() {
        return "";
      },
      discard() {
        return "";
      },
    });

    await expect(
      controller.handle("edit ../../../outside/weather --project", {
        print() {},
        openEditor: async () => {},
      }),
    ).rejects.toThrow("workflow name must use");
    expect(opened).toBe(false);
  });

  test("delegates list and dry-run to the shared service", async () => {
    const calls: string[] = [];
    const controller = new WorkflowCommandController({
      list() {
        calls.push("list");
        return [{ name: "weather", source: "project", description: "Weather" }];
      },
      dryRun(name: string) {
        calls.push(`dry:${name}`);
        return {
          workflow: name,
          revision: 1,
          source: "project",
          packageHash: "p",
          executionHash: "e",
          workflowTimeoutMs: 1_000,
          steps: [],
          preflight: {
            permissions: {
              network: [],
              commands: [],
              filesystem: { read: [], write: [] },
              model: false,
            },
            maximumAttempts: 0,
            maximumModelCalls: 0,
            effect: "read-only",
            requiredSecrets: [],
            unresolved: [],
          },
          summary: "Effect: read-only",
        };
      },
    } as never);
    const printed: string[] = [];
    await controller.handle("list", { print: (value) => printed.push(value) });
    await controller.handle("dry-run weather", { print: (value) => printed.push(value) });
    expect(calls).toEqual(["list", "dry:weather"]);
    expect(printed.join("\n")).toContain("weather");
  });

  test("directs manual package lifecycle commands to the shell without consuming creator drafts", async () => {
    let creatorReads = 0;
    let creatorDiscards = 0;
    const controller = new WorkflowCommandController({} as never, {
      creator: {
        latest() {
          creatorReads++;
          return undefined;
        },
        discard() {
          creatorDiscards++;
        },
      } as never,
      activate: () => ({ activeDir: "" }),
    });
    const printed: string[] = [];
    const context = { print: (value: string) => printed.push(value) };

    await controller.handle("revise weather-fetch", context);
    await controller.handle("review weather-fetch", context);
    await controller.handle("publish weather-fetch --global", context);
    await controller.handle("discard weather-fetch", context);
    await controller.handle("init another-workflow", context);

    expect(creatorReads).toBe(0);
    expect(creatorDiscards).toBe(0);
    expect(printed).toHaveLength(5);
    expect(printed[0]).toContain("run from your shell");
    expect(printed[0]).toContain("cleetus workflow revise weather-fetch");
    expect(printed[1]).toContain("cleetus workflow review weather-fetch");
    expect(printed[2]).toContain("cleetus workflow publish weather-fetch --global");
    expect(printed[3]).toContain("cleetus workflow discard weather-fetch");
    expect(printed[4]).toContain("cleetus workflow init another-workflow");
    expect(printed[0]).toContain(
      "`/workflow review` and `/workflow discard` without a workflow name",
    );
  });

  test("marks selected human-facing run output as Markdown", async () => {
    const controller = new WorkflowCommandController({
      show() {
        return {
          manifest: { inputs: {}, presentation: { output: "summary" } },
        };
      },
      async run() {
        return {
          run_id: "run-one",
          workflow: "weather",
          revision: 1,
          execution_hash: "hash",
          status: "succeeded",
          outputs: { summary: "## Forecast\n\n- Mild" },
        };
      },
    } as never);
    const printed: Array<{ value: string; presentation: unknown }> = [];

    await controller.handle("run weather {}", {
      print(value, presentation) {
        printed.push({ value, presentation });
      },
    });

    expect(printed).toEqual([
      {
        value: "## Forecast\n\n- Mild",
        presentation: {
          format: "markdown",
          kind: "result",
          workflow: "weather",
          status: "succeeded",
          runId: "run-one",
        },
      },
    ]);
  });

  test("uses the shared replacement preflight before interactive input collection", async () => {
    let collected = 0;
    let runs = 0;
    const controller = new WorkflowCommandController({
      executionConflict() {
        return {
          kind: "replacement_draft",
          draftId: "01KYNTESTDRAFT000000000000",
          workflow: "weather",
          scope: "project",
          activeRevision: 1,
          pendingRevision: 2,
        };
      },
      async run() {
        runs++;
        throw new Error("active revision must not run");
      },
    } as never);
    const output: string[] = [];

    await controller.handle("run weather", {
      print(value) {
        output.push(value);
      },
      async collectInputs() {
        collected++;
        return {};
      },
    });

    expect(collected).toBe(0);
    expect(runs).toBe(0);
    expect(output.at(-1)).toContain("valid replacement revision 2");
    expect(output.at(-1)).toContain("active revision was not run");
  });

  test("inspects the latest workflow run with bounded step and model details", async () => {
    const controller = new WorkflowCommandController({
      history() {
        return [
          {
            id: "run-one",
            workflowName: "decision-review",
            revision: 1,
            status: "succeeded",
            createdAt: 0,
          },
        ];
      },
      runDetail() {
        return {
          run: {
            id: "run-one",
            workflowName: "decision-review",
            revision: 1,
            packageHash: "p",
            executionHash: "e",
            status: "succeeded",
            workspace: "/work",
            inputs: {},
            createdAt: 0,
          },
          steps: [
            {
              runId: "run-one",
              stepId: "critique",
              ordinal: 0,
              uses: "llm.generate@1",
              effect: "read-only",
              status: "succeeded",
              attempts: 1,
            },
          ],
          attempts: [],
          modelAttempts: [
            {
              runId: "run-one",
              stepId: "critique",
              attempt: 1,
              provider: "local",
              requestedModel: "model-a",
              finishReason: "stop",
              promptHash: "hash",
              constrained: true,
              startedAt: 0,
              endedAt: 1,
            },
          ],
        };
      },
    } as never);
    const printed: string[] = [];

    await controller.handle("history decision-review latest", {
      print: (value) => printed.push(value),
    });

    expect(printed.join("\n")).toContain("Run: run-one");
    expect(printed.join("\n")).toContain("critique (llm.generate@1) — succeeded");
    expect(printed.join("\n")).toContain("local/model-a");
  });

  test("renders host-computed revision operations, semantic changes, authority, and risk", async () => {
    const manifest = {
      schema_version: 1,
      name: "weather",
      revision: 2,
      description: "Render a warmer greeting",
      inputs: { type: "object", properties: {}, additionalProperties: false },
      permissions: {},
      execution: { timeout: "1m" },
      steps: [
        {
          id: "render",
          uses: "text.template@1",
          with: { data: {}, template: "Howdy" },
        },
      ],
      outputs: { result: { value: "$steps.render.output.text", schema: { type: "string" } } },
      presentation: { output: "result" },
    };
    const record = {
      id: "01KYNTESTDRAFT000000000000",
      scope: "project",
      name: "weather",
      targetRevision: 2,
      revisionProtocol: "change-set-v1",
      phase: "draft",
      createdAt: "2026-07-28T00:00:00Z",
      updatedAt: "2026-07-28T00:00:00Z",
      messages: [],
      diagnostics: [],
      output: {
        response: "Ready",
        mode: "revise",
        phase: "draft",
        summary: "Render a warmer greeting",
        manifest,
        assumptions: [],
        unresolvedQuestions: [],
      },
      changeSet: {
        schemaVersion: 1,
        base: {
          name: "weather",
          scope: "project",
          revision: 1,
          packageHash: "package",
          executionHash: "execution",
        },
        summary: "Render a warmer greeting",
        operations: [
          {
            op: "upsert-step",
            id: "update-render",
            rationale: "Use the requested greeting",
            step: manifest.steps[0],
          },
        ],
      },
      semanticDiff: {
        targetRevision: 2,
        changes: [
          {
            id: "steps:steps.render",
            category: "steps",
            path: "steps.render",
            before: '{"template":"Hello"}',
            after: '{"template":"Howdy"}',
            operationId: "update-render",
          },
        ],
        authority: { added: [], removed: [] },
        riskFlags: ["step graph changed"],
        operationCoverage: [{ operationId: "update-render", changeIds: ["steps:steps.render"] }],
        derivedChanges: [],
        unattributedChanges: [],
      },
    };
    const controller = new WorkflowCommandController({} as never, {
      creator: {
        latest: () => record,
        get: () => record,
      } as never,
      activate: () => ({ activeDir: "" }),
    });
    const output: string[] = [];

    await controller.handle("review", {
      sessionId: "review-session",
      print(value) {
        output.push(value);
      },
    });

    expect(output.at(-1)).toContain("Requested change: Render a warmer greeting");
    expect(output.at(-1)).toContain("upsert-step (update-render)");
    expect(output.at(-1)).toContain("steps: steps.render");
    expect(output.at(-1)).toContain("Authority added: none");
    expect(output.at(-1)).toContain("Risk flags: step graph changed");
  });

  test("labels fresh creation authority as derived or explicit during review", async () => {
    const manifest = {
      schema_version: 1,
      name: "account-brief",
      revision: 1,
      description: "Fetch and summarize one account",
      inputs: { type: "object", properties: {}, additionalProperties: false },
      permissions: {
        network: [{ host: "api.example.test", methods: ["GET"] }],
        filesystem: { read: ["$project/data/**"] },
        model: true,
      },
      execution: { timeout: "5m" },
      steps: [
        {
          id: "fetch",
          uses: "http.request@1",
          with: { url: "https://api.example.test/account" },
        },
        {
          id: "summarize",
          uses: "llm.generate@1",
          with: {
            prompt: "Summarize.",
            input: "$steps.fetch.output.body",
            output_schema: { type: "string" },
          },
        },
      ],
      outputs: {
        result: { value: "$steps.summarize.output", schema: { type: "string" } },
      },
      presentation: { output: "result" },
    };
    const record = {
      id: "01KYNFRESHDRAFT00000000000",
      scope: "project",
      name: "account-brief",
      targetRevision: 1,
      phase: "draft",
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
      messages: [],
      diagnostics: [],
      output: {
        response: "Ready",
        phase: "draft",
        manifest,
        authority: {
          derived: ["model calls", "network GET api.example.test"],
          explicit: ["read $project/data/**"],
        },
        compilerNotes: ["Updated deterministic snapshot expectation in tests/success.yaml."],
        assumptions: [],
        unresolvedQuestions: [],
      },
    };
    const controller = new WorkflowCommandController({} as never, {
      creator: {
        latest: () => record,
        get: () => record,
      } as never,
      activate: () => ({ activeDir: "" }),
    });
    const output: string[] = [];

    await controller.handle("review", {
      sessionId: "review-session",
      print(value) {
        output.push(value);
      },
    });

    expect(output.at(-1)).toContain(
      "Derived permissions: model calls, network GET api.example.test",
    );
    expect(output.at(-1)).toContain("Explicit permissions: read $project/data/**");
    expect(output.at(-1)).toContain("Compiler notes:");
    expect(output.at(-1)).toContain(
      "Updated deterministic snapshot expectation in tests/success.yaml.",
    );
  });
});
