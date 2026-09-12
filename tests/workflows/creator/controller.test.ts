import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowCreatorController } from "../../../src/workflows/creator/controller";
import { WorkflowDraftStore } from "../../../src/workflows/creator/draft-store";
import { WorkflowCreatorResponseError } from "../../../src/workflows/creator/model";
import type { WorkflowManifest } from "../../../src/workflows/parse";
import { resolved } from "../../../src/workflows/provenance";
import { WorkflowSchemaService } from "../../../src/workflows/schema";
import { WorkflowStepRegistry } from "../../../src/workflows/step-registry";
import { createAssertSchemaStep } from "../../../src/workflows/steps/assert-schema";
import { createCommandRunStep } from "../../../src/workflows/steps/command-run";
import { dataSelectStep } from "../../../src/workflows/steps/data-select";
import { textTemplateStep } from "../../../src/workflows/steps/text-template";

function httpRegistry(): WorkflowStepRegistry {
  const registry = new WorkflowStepRegistry();
  registry.register({
    name: "http.request",
    version: 1,
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        response: { enum: ["json", "text"] },
        headers: { type: "object" },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    defaultTimeoutMs: 1_000,
    classify: () => ({
      effect: "read-only",
      permissions: {
        network: [{ host: "api.github.com", methods: ["GET"] }],
      },
      retryable: [],
    }),
    preview: () => "GET api.github.com",
    execute: async () => resolved({}),
  });
  return registry;
}

function llmRegistry(): WorkflowStepRegistry {
  const registry = new WorkflowStepRegistry();
  registry.register({
    name: "llm.generate",
    version: 1,
    inputSchema: {
      type: "object",
      required: ["prompt", "input", "output_schema"],
      properties: {
        prompt: { type: "string" },
        input: {},
        output_schema: { type: "object" },
      },
      additionalProperties: false,
    },
    outputSchema: {},
    defaultTimeoutMs: 120_000,
    classify: () => ({
      effect: "read-only",
      permissions: { model: true },
      retryable: [],
    }),
    preview: () => "generate",
    execute: async () => resolved({}),
  });
  return registry;
}

function startLegacy(
  controller: WorkflowCreatorController,
  store: WorkflowDraftStore,
  input: Parameters<WorkflowCreatorController["start"]>[0],
) {
  const draft = controller.start(input);
  draft.creationProtocol = "legacy-full-package";
  draft.requirementMessages = undefined;
  store.save(draft);
  return draft;
}

describe("WorkflowCreatorController", () => {
  test("persists host revision context while waiting for the requested change", () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          throw new Error("the model must not be called while opening the revision interview");
        },
      },
      "Interview.",
      {} as never,
    );

    const draft = startLegacy(controller, store, {
      name: "weather",
      targetRevision: 2,
      initialMessages: [{ role: "user", content: "[Host revision context]\nBase revision 1." }],
      initialQuestions: ["What would you like to change in `weather`?"],
    });

    expect(draft.phase).toBe("questions");
    expect(draft.messages).toEqual([
      { role: "user", content: "[Host revision context]\nBase revision 1." },
    ]);
    expect(draft.output?.unresolvedQuestions).toEqual([
      "What would you like to change in `weather`?",
    ]);
    expect(store.get(draft.id)).toMatchObject({
      targetRevision: 2,
      messages: draft.messages,
      output: draft.output,
    });
  });

  test("hydrates structured revision state for a draft created by an older host", () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          throw new Error("not called");
        },
      },
      "Interview.",
      {} as never,
    );
    const draft = startLegacy(controller, store, { name: "weather", targetRevision: 2 });
    const manifest = {
      schema_version: 1,
      name: "weather",
      revision: 1,
      description: "Render weather.",
      inputs: { type: "object", properties: {}, additionalProperties: false },
      permissions: {},
      execution: { timeout: "1m" },
      steps: [],
      outputs: {},
    } as WorkflowManifest;
    const resources = [{ path: "tests/existing.yaml", content: "{}" }];

    const hydrated = controller.ensureRevisionBase(draft.id, manifest, resources);
    controller.ensureRevisionBase(draft.id, { ...manifest, description: "Do not replace." }, []);

    expect(hydrated?.baseManifest).toEqual(manifest);
    expect(store.get(draft.id)?.baseResources).toEqual(resources);
    expect(store.get(draft.id)?.baseManifest?.description).toBe("Render weather.");
  });

  test("blocks an external creator draft that omits a complete offline mock test", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = httpRegistry();
    let calls = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "ghget",
              revision: 1,
              description: "Fetch a GitHub repository.",
              inputs: { type: "object", properties: {}, additionalProperties: false },
              permissions: {
                network: [{ host: "api.github.com", methods: ["GET"] }],
              },
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "fetch",
                  uses: "http.request@1",
                  with: { url: "https://api.github.com/repos/oven-sh/bun", method: "GET" },
                },
              ],
              outputs: {
                repository: {
                  value: "$steps.fetch.output",
                  schema: { type: "object" },
                },
              },
            },
            resources: [],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "ghget" });

    const result = await controller.respond(
      draft.id,
      "Fetch a GitHub repository and return its response.",
    );

    expect(calls).toBe(2);
    expect(result.diagnostics).toContainEqual({
      path: "tests",
      message: expect.stringContaining("offline tests/*.yaml"),
    });
    expect(
      result.messages.some(
        (message) =>
          message.role === "user" && message.content.includes("mock every external step"),
      ),
    ).toBe(true);
    const feedback = result.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    expect(feedback).toContain("mocks.<step-id> must contain output or error");
    expect(feedback).not.toContain('"code":');
  });

  test("normalizes host-owned revision and unwrapped mock envelopes", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-drafts-"));
    const store = new WorkflowDraftStore(root);
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          return {
            response: "Drafted ghget v5.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "ghget",
              revision: 5,
              description: "Fetch a public GitHub repository.",
              inputs: { type: "object", properties: {}, additionalProperties: false },
              permissions: {
                network: [{ host: "api.github.com", methods: ["GET"] }],
              },
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "fetch-repo",
                  uses: "http.request@1",
                  with: { url: "https://api.github.com/repos/oven-sh/bun", method: "GET" },
                },
              ],
              outputs: {
                repository: {
                  value: { ref: "step-output", step: "fetch-repo", path: [] },
                  schema: { type: "object" },
                },
              },
              presentation: { output: "repository" },
            },
            resources: [
              {
                path: "tests/success.yaml",
                content: [
                  "schema_version: 1",
                  "name: public repository",
                  "mocks:",
                  "  fetch-repo:",
                  "    status: 200",
                  "    content_type: application/json",
                  "    final_url: https://api.github.com/repos/oven-sh/bun",
                  "    body:",
                  "      name: bun",
                  "expect:",
                  "  status: succeeded",
                  "  outputs:",
                  "    repository:",
                  "      status: 200",
                  "      content_type: application/json",
                  "      final_url: https://api.github.com/repos/oven-sh/bun",
                  "      body:",
                  "        name: bun",
                  "",
                ].join("\n"),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      httpRegistry(),
    );
    const draft = startLegacy(controller, store, { name: "ghget", targetRevision: 1 });

    const result = await controller.respond(
      draft.id,
      "Fetch repository information and return it.",
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.output?.manifest?.revision).toBe(1);
    expect(result.output?.manifest?.outputs.repository?.value).toBe("$steps.fetch-repo.output");
    const testContent = result.output?.resources?.find(
      (resource) => resource.path === "tests/success.yaml",
    )?.content;
    const testCase = JSON.parse(testContent ?? "{}");
    expect(testCase.mocks["fetch-repo"].output).toMatchObject({
      status: 200,
      body: { name: "bun" },
    });
  });

  test("declares model authority for creator drafts containing model steps", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "model-authority",
              revision: 1,
              description: "Generate one structured message.",
              inputs: { type: "object", properties: {}, additionalProperties: false },
              permissions: {},
              execution: { timeout: "5m" },
              steps: [
                {
                  id: "generate",
                  uses: "llm.generate@1",
                  with: {
                    prompt: "Return one message.",
                    input: null,
                    output_schema: {
                      type: "object",
                      required: ["message"],
                      properties: { message: { type: "string" } },
                      additionalProperties: false,
                    },
                  },
                },
              ],
              outputs: {
                message: {
                  value: "$steps.generate.output.message",
                  schema: { type: "string" },
                },
              },
              presentation: { output: "message" },
            },
            resources: [
              {
                path: "tests/success.yaml",
                content: JSON.stringify({
                  schema_version: 1,
                  name: "success",
                  mode: "mock",
                  inputs: {},
                  mocks: { generate: { output: { message: "Hello." } } },
                  expect: { status: "succeeded", outputs: { message: "Hello." } },
                }),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      llmRegistry(),
    );
    const draft = startLegacy(controller, store, { name: "model-authority" });

    const result = await controller.respond(draft.id, "Generate one structured message.");

    expect(result.diagnostics).toEqual([]);
    expect(result.output?.manifest?.permissions).toEqual({ model: true });
  });

  test("repairs an underspecified Exercise 5 option schema and preserves distinct model contracts", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = llmRegistry();
    registry.register(textTemplateStep);
    let calls = 0;
    const recommendationSchema = {
      type: "object",
      required: ["choice", "rationale", "risks", "assumptions"],
      properties: {
        choice: { type: "string" },
        rationale: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
        assumptions: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    };
    const reviewSchema = {
      type: "object",
      required: ["recommendation", "confidence", "supporting_points", "concerns", "next_actions"],
      properties: {
        recommendation: { type: "string" },
        confidence: { enum: ["low", "medium", "high"] },
        supporting_points: { type: "array", items: { type: "string" } },
        concerns: { type: "array", items: { type: "string" } },
        next_actions: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    };
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          const repaired = calls > 1;
          return {
            response: repaired ? "Repaired decision review." : "Drafted decision review.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "decision-review",
              revision: 1,
              description: "Recommend, independently review, and present a decision.",
              inputs: {
                type: "object",
                required: ["question", "options", "constraints"],
                properties: {
                  question: { type: "string", minLength: 1 },
                  options: {
                    type: "array",
                    items: repaired
                      ? {
                          type: "object",
                          required: ["name", "advantages", "disadvantages"],
                          properties: {
                            name: { type: "string", minLength: 1 },
                            advantages: { type: "array", items: { type: "string" } },
                            disadvantages: { type: "array", items: { type: "string" } },
                          },
                          additionalProperties: false,
                        }
                      : { type: "object" },
                  },
                  constraints: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
              permissions: {},
              execution: { timeout: "5m" },
              steps: [
                {
                  id: "recommend",
                  uses: "llm.generate@1",
                  with: {
                    prompt: "Recommend one option using the question, options, and constraints.",
                    input: null,
                    output_schema: recommendationSchema,
                  },
                },
                {
                  id: "review",
                  uses: "llm.generate@1",
                  with: {
                    prompt:
                      "Independently critique and refine the proposed recommendation using all decision inputs.",
                    input: {
                      question: "$inputs.question",
                      options: "$inputs.options",
                      constraints: "$inputs.constraints",
                      proposed: "$steps.recommend.output",
                    },
                    output_schema: reviewSchema,
                  },
                },
                {
                  id: "present",
                  uses: "text.template@1",
                  with: {
                    data: { review: "$steps.review.output" },
                    template:
                      "# Decision Review\nRecommendation: {{review.recommendation}}\nConfidence: {{review.confidence}}",
                  },
                },
              ],
              outputs: {
                result: {
                  value: "$steps.present.output",
                  schema: { type: "string" },
                },
              },
              presentation: { output: "result" },
            } as WorkflowManifest,
            resources: [
              {
                path: "tests/success.yaml",
                content: JSON.stringify({
                  schema_version: 1,
                  name: "success",
                  mode: "mock",
                  inputs: {
                    question: "Which approach?",
                    options: [
                      {
                        name: "Explicit revision",
                        advantages: ["Clear"],
                        disadvantages: ["More commands"],
                      },
                    ],
                    constraints: ["Preserve history"],
                  },
                  mocks: {
                    recommend: {
                      output: {
                        choice: "Explicit revision",
                        rationale: ["Clear intent"],
                        risks: ["Larger surface"],
                        assumptions: ["Users value clarity"],
                      },
                    },
                    review: {
                      output: {
                        recommendation: "Use explicit revision",
                        confidence: "high",
                        supporting_points: ["Clear intent"],
                        concerns: ["Command growth"],
                        next_actions: ["Prototype"],
                      },
                    },
                  },
                  expect: {
                    status: "succeeded",
                    outputs: {
                      result:
                        "# Decision Review\nRecommendation: Use explicit revision\nConfidence: high",
                    },
                  },
                }),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "decision-review" });

    const result = await controller.respond(
      draft.id,
      "Accept options with advantages and disadvantages, recommend one, then critique it.",
    );

    expect(calls).toBe(2);
    expect(result.diagnostics).toEqual([]);
    expect(result.output?.manifest?.permissions).toEqual({ model: true });
    const manifest = result.output?.manifest as WorkflowManifest;
    const inputProperties = manifest.inputs.properties as Record<string, unknown>;
    expect(inputProperties.options).toMatchObject({
      items: {
        required: ["name", "advantages", "disadvantages"],
        additionalProperties: false,
      },
    });
    expect((manifest.steps[0]?.with as Record<string, unknown>).output_schema).toEqual(
      recommendationSchema,
    );
    expect((manifest.steps[0]?.with as Record<string, unknown>).input).toEqual({
      question: "$inputs.question",
      options: "$inputs.options",
      constraints: "$inputs.constraints",
    });
    expect((manifest.steps[1]?.with as Record<string, unknown>).output_schema).toEqual(
      reviewSchema,
    );
    expect(
      result.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("preserve every object field the user named"),
      ),
    ).toBe(true);
  });

  test("normalizes an ex3 secret header and strict empty inputs before offline execution", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    let calls = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "github-account-brief",
              revision: 1,
              description: "Fetch the authenticated GitHub account.",
              inputs: {},
              secrets: {
                github_token: {
                  source: "env",
                  name: "CLEETUS_WORKFLOW_GITHUB_TOKEN",
                  expose_to_llm: [],
                },
              },
              permissions: {
                network: [{ host: "api.github.com", methods: ["GET"] }],
              },
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "fetch",
                  uses: "http.request@1",
                  with: {
                    url: "https://api.github.com/user",
                    method: "GET",
                    headers: {
                      Authorization: "Bearer ${{ secrets.github_token }}",
                    },
                  },
                },
              ],
              outputs: {
                account: {
                  value: "$steps.fetch.output.body",
                  schema: { type: "object" },
                },
              },
              presentation: { output: "account" },
            },
            resources: [
              {
                path: "tests/success.yaml",
                content: JSON.stringify({
                  schema_version: 1,
                  name: "authenticated account",
                  mode: "mock",
                  inputs: {},
                  mocks: {
                    fetch: {
                      output: {
                        status: 200,
                        content_type: "application/json",
                        final_url: "https://api.github.com/user",
                        body: { login: "testuser" },
                      },
                    },
                  },
                  expect: {
                    status: "succeeded",
                    outputs: { account: { login: "testuser" } },
                  },
                }),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      httpRegistry(),
    );
    const draft = startLegacy(controller, store, { name: "github-account-brief" });

    const result = await controller.respond(draft.id, "Fetch my GitHub account.");

    expect(calls).toBe(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.output?.manifest?.inputs).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    const fetchWith = result.output?.manifest?.steps[0]?.with as
      | Record<string, unknown>
      | undefined;
    expect(fetchWith?.headers).toEqual({
      Authorization: "Bearer ${secrets.github_token}",
    });
  });

  test("repairs an ex3 missing private-repo field with data.select default and two tests", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = httpRegistry();
    registry.register(dataSelectStep);
    registry.register(textTemplateStep);
    let calls = 0;
    let repairFeedback = "";
    const testResource = (present: boolean) => ({
      path: `tests/private-repos-${present ? "present" : "absent"}.yaml`,
      content: JSON.stringify({
        schema_version: 1,
        name: `private repos ${present ? "present" : "absent"}`,
        mode: "mock",
        inputs: {},
        mocks: {
          fetch: {
            output: {
              status: 200,
              content_type: "application/json",
              final_url: "https://api.github.com/user",
              body: {
                login: "testuser",
                name: "Test User",
                public_repos: 10,
                ...(present ? { total_private_repos: 5 } : {}),
                html_url: "https://github.com/testuser",
              },
            },
          },
        },
        expect: {
          status: "succeeded",
          outputs: {
            summary: [
              "# GitHub Account Summary",
              "",
              "- **Login**: testuser",
              "- **Name**: Test User",
              "- **Public Repos**: 10",
              `- **Private Repos**: ${present ? 5 : "Unavailable to this token"}`,
              "- **Profile URL**: https://github.com/testuser",
              "",
            ].join("\n"),
          },
        },
      }),
    });
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond(input) {
          calls++;
          repairFeedback = input.messages.at(-1)?.content ?? "";
          return {
            response: "Drafted the private repository fallback.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "github-account-brief",
              revision: 2,
              description: "Render an authenticated GitHub account summary.",
              inputs: { type: "object", properties: {}, additionalProperties: false },
              secrets: {
                github_token: {
                  source: "env",
                  name: "CLEETUS_WORKFLOW_GITHUB_TOKEN",
                  expose_to_llm: [],
                },
              },
              permissions: {
                network: [{ host: "api.github.com", methods: ["GET"] }],
              },
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "fetch",
                  uses: "http.request@1",
                  with: {
                    url: "https://api.github.com/user",
                    method: "GET",
                    headers: { Authorization: "Bearer ${secrets.github_token}" },
                  },
                },
                {
                  id: "select",
                  uses: "data.select@1",
                  with: { value: "$steps.fetch.output", pointer: "/body" },
                },
                {
                  id: "select-private",
                  uses: "data.select@1",
                  with: {
                    value: "$steps.select.output",
                    pointer: "/total_private_repos",
                    ...(calls > 1 ? { default: "Unavailable to this token" } : {}),
                  },
                },
                {
                  id: "render",
                  uses: "text.template@1",
                  with: {
                    template: [
                      "# GitHub Account Summary",
                      "",
                      "- **Login**: {{login}}",
                      "- **Name**: {{name}}",
                      "- **Public Repos**: {{public_repos}}",
                      "- **Private Repos**: {{private_repos}}",
                      "- **Profile URL**: {{html_url}}",
                      "",
                    ].join("\n"),
                    data: {
                      login: "$steps.select.output.login",
                      name: "$steps.select.output.name",
                      public_repos: "$steps.select.output.public_repos",
                      private_repos: "$steps.select-private.output",
                      html_url: "$steps.select.output.html_url",
                    },
                  },
                },
              ],
              outputs: {
                summary: { value: "$steps.render.output", schema: { type: "string" } },
              },
              presentation: { output: "summary" },
            } as WorkflowManifest,
            resources: [testResource(true), testResource(false)],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, {
      name: "github-account-brief",
      targetRevision: 2,
    });

    const result = await controller.respond(
      draft.id,
      "Keep private repos and use a deterministic fallback when the field is absent.",
    );

    expect(calls).toBe(2);
    expect(repairFeedback).toContain("supports with.default");
    expect(repairFeedback).toContain("do not invent host null-coalescing or add an LLM");
    expect(result.diagnostics).toEqual([]);
    expect(result.output?.manifest?.steps.some((step) => step.uses === "llm.generate@1")).toBe(
      false,
    );
    expect(result.output?.manifest?.steps[2]?.with).toMatchObject({
      pointer: "/total_private_repos",
      default: "Unavailable to this token",
    });
    expect(result.output?.resources).toHaveLength(2);
  });

  test("repairs an Exercise 4 packaged Bun command and normalizes its mock envelope", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    let calls = 0;
    let repairFeedback = "";
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond(input) {
          calls++;
          repairFeedback = input.messages.at(-1)?.content ?? "";
          const outputMode = calls === 1 ? "stdout" : "json";
          return {
            response: "Drafted the workspace inventory.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "workspace-inventory",
              revision: 1,
              description: "Inventory the current project with a packaged read-only Bun script.",
              inputs: { type: "object", properties: {}, additionalProperties: false },
              permissions: {
                commands: [
                  {
                    program: "bun",
                    args_prefix:
                      calls === 1
                        ? ["./scripts/workspace-inventory.ts"]
                        : ["run", "./scripts/workspace-inventory.ts"],
                  },
                ],
                filesystem: { read: calls === 1 ? ["/"] : ["$project/**"], write: [] },
              },
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "run-inventory",
                  uses: "command.run@1",
                  with: {
                    program: "bun",
                    args:
                      calls === 1
                        ? ["./scripts/workspace-inventory.ts"]
                        : ["run", "./scripts/workspace-inventory.ts"],
                    output: outputMode,
                  },
                },
                {
                  id: "validate-inventory",
                  uses: "assert.schema@1",
                  with: {
                    value: "$steps.run-inventory.output.stdout",
                    schema: {
                      type: "object",
                      required: [
                        "package_name",
                        "source_files",
                        "test_files",
                        "documentation_files",
                        "detected_languages",
                      ],
                      properties: {
                        package_name: { type: "string" },
                        source_files: { type: "integer", minimum: 0 },
                        test_files: { type: "integer", minimum: 0 },
                        documentation_files: { type: "integer", minimum: 0 },
                        detected_languages: {
                          type: "array",
                          items: { type: "string" },
                          maxItems: 20,
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                },
                {
                  id: "render-inventory",
                  uses: "text.template@1",
                  with: {
                    template: [
                      "# Workspace Inventory",
                      "",
                      "- Package: {{package_name}}",
                      "- Source files: {{source_files}}",
                      "- Test files: {{test_files}}",
                      "- Documentation files: {{documentation_files}}",
                      "- Languages:",
                      "{{#each detected_languages}}  - {{this}}",
                      "{{/each}}",
                    ].join("\n"),
                    data: "$steps.validate-inventory.output",
                  },
                },
              ],
              outputs: {
                inventory: {
                  value: "$steps.render-inventory.output",
                  schema: { type: "string" },
                },
              },
              presentation: { output: "inventory" },
            } as WorkflowManifest,
            resources: [
              {
                path: "scripts/workspace-inventory.ts",
                content:
                  calls === 1
                    ? 'import path from "node:path";\nconst extensions = { src: [".ts"], test: [".test.ts", ".spec.ts"] };\nconst ext = path.extname("example.test.ts");\nif (extensions.src.includes(ext)) console.log("source");\nelse if (extensions.test.includes(ext)) console.log("test");\n'
                    : 'const name = "example.test.ts".toLowerCase();\nconst kind = name.endsWith(".test.ts") ? "test" : "source";\nconsole.log(JSON.stringify({ package_name: "fixture", source_files: kind === "source" ? 1 : 0, test_files: kind === "test" ? 1 : 0, documentation_files: 1, detected_languages: ["TypeScript", "Markdown"] }));\n',
              },
              {
                path: "tests/success.yaml",
                content: JSON.stringify({
                  schema_version: 1,
                  name: "workspace inventory",
                  mode: "mock",
                  inputs: {},
                  mocks: {
                    "run-inventory": {
                      output: {
                        status: "succeeded",
                        stdout: JSON.stringify({
                          package_name: "fixture",
                          source_files: 2,
                          test_files: 1,
                          documentation_files: 1,
                          detected_languages: ["TypeScript", "Markdown"],
                        }),
                        stderr: "",
                        exit_code: 0,
                      },
                    },
                  },
                  expect: {
                    status: "succeeded",
                    outputs: {
                      inventory: [
                        "# Workspace Inventory",
                        "",
                        "- Package: fixture",
                        "- Source files: 2",
                        "- Test files: 1",
                        "- Documentation files: 1",
                        "- Languages:",
                        "  - TypeScript",
                        "  - Markdown",
                        "",
                      ].join("\n"),
                    },
                  },
                }),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      (packageDir) => {
        const registry = new WorkflowStepRegistry();
        registry.register(
          createCommandRunStep({
            packageDir,
            sandbox: {
              async exec() {
                throw new Error("offline test must mock the command");
              },
              async dispose() {},
              writeRoot: () => null,
            },
          }),
        );
        registry.register(createAssertSchemaStep(new WorkflowSchemaService()));
        registry.register(textTemplateStep);
        return registry;
      },
    );
    const draft = startLegacy(controller, store, { name: "workspace-inventory" });

    const result = await controller.respond(
      draft.id,
      "Inventory this project with a packaged Bun script and render Markdown.",
    );

    expect(calls).toBe(2);
    expect(repairFeedback).toContain("must be exactly 'text' or 'json', never 'stdout'");
    expect(repairFeedback).toContain("must use program: bun with args:");
    expect(repairFeedback).toContain("must not request the entire filesystem root");
    expect(repairFeedback).toContain("cannot be detected with path.extname()");
    expect(result.diagnostics).toEqual([]);
    expect(result.output?.manifest?.steps[0]?.with).toMatchObject({
      program: "bun",
      args: ["run", "./scripts/workspace-inventory.ts"],
      output: "json",
    });
    expect(result.output?.resources?.[0]?.path).toBe("scripts/workspace-inventory.ts");
    expect(result.output?.manifest?.permissions.commands?.[0]?.args_prefix).toEqual([
      "run",
      "./scripts/workspace-inventory.ts",
    ]);
    expect(result.output?.resources?.[1]?.content).toContain('"survivors": []');
    expect(result.output?.resources?.[1]?.content).toContain('"package_name": "fixture"');
  });

  test("rejects executable fallback syntax in a creator-generated text template", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register({
      name: "text.template",
      version: 1,
      inputSchema: {
        type: "object",
        required: ["template", "data"],
        properties: { template: { type: "string" }, data: {} },
        additionalProperties: false,
      },
      outputSchema: { type: "string" },
      defaultTimeoutMs: 1_000,
      classify: () => ({ effect: "read-only", permissions: {}, retryable: [] }),
      preview: () => "render",
      execute: async () => resolved(""),
    });
    let calls = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "fallback",
              revision: 4,
              description: "Render a value.",
              inputs: { type: "object", properties: {}, additionalProperties: false },
              permissions: {},
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "render",
                  uses: "text.template@1",
                  with: {
                    template: "Language: ${steps.fetch.output.body.language || 'N/A'}",
                    data: {},
                  },
                },
              ],
              outputs: {
                text: { value: "$steps.render.output", schema: { type: "string" } },
              },
              presentation: { output: "text" },
            },
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "fallback" });

    const result = await controller.respond(draft.id, "Render a fallback for a missing value.");

    expect(calls).toBe(2);
    expect(result.output?.manifest?.revision).toBe(1);
    expect(result.diagnostics).toContainEqual({
      path: "steps.render.with.template",
      message: expect.stringContaining("does not support executable fallback expressions"),
    });
  });

  test("requires creator-generated required string inputs to reject empty values explicitly", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register(textTemplateStep);
    let calls = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "echo-name",
              revision: 1,
              description: "Render a supplied name.",
              inputs: {
                type: "object",
                required: ["name"],
                properties: {
                  name: calls === 1 ? { type: "string" } : { type: "string", minLength: 1 },
                },
                additionalProperties: false,
              },
              permissions: {},
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "render",
                  uses: "text.template@1",
                  with: { template: "Name: {{name}}", data: "$inputs" },
                },
              ],
              outputs: {
                text: { value: "$steps.render.output", schema: { type: "string" } },
              },
              presentation: { output: "text" },
            },
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "echo-name" });

    const result = await controller.respond(draft.id, "Render a required name.");

    expect(calls).toBe(2);
    expect(result.diagnostics).toEqual([]);
    const feedback = result.messages.find(
      (message) =>
        message.role === "user" && message.content.includes("[Host validation feedback]"),
    )?.content;
    expect(feedback).toContain("inputs.properties.name");
    expect(feedback).toContain("minLength");
  });

  test("repairs a data.select slash that incorrectly treats an already-selected body as root", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = httpRegistry();
    registry.register(dataSelectStep);
    let calls = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          const repaired = calls > 2;
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "select-body",
              revision: 1,
              description: "Select an HTTP response body.",
              inputs: { type: "object", properties: {}, additionalProperties: false },
              permissions: {
                network: [{ host: "api.github.com", methods: ["GET"] }],
              },
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "fetch",
                  uses: "http.request@1",
                  with: { url: "https://api.github.com/repos/oven-sh/bun", method: "GET" },
                },
                {
                  id: "select",
                  uses: "data.select@1",
                  with: repaired
                    ? { value: "$steps.fetch.output", pointer: "/body" }
                    : { value: "$steps.fetch.output.body", pointer: "/" },
                },
              ],
              outputs: {
                body: { value: "$steps.select.output", schema: { type: "object" } },
              },
              presentation: { output: "body" },
            } as WorkflowManifest,
            resources: [
              {
                path: "tests/success.yaml",
                content: [
                  "schema_version: 1",
                  "name: selected body",
                  "mode: mock",
                  "inputs: {}",
                  "mocks:",
                  "  fetch:",
                  "    output:",
                  "      status: 200",
                  "      content_type: application/json",
                  "      final_url: https://api.github.com/repos/oven-sh/bun",
                  "      body: { name: bun }",
                  "expect:",
                  "  status: succeeded",
                  "  outputs:",
                  "    body: { name: bun }",
                  "",
                ].join("\n"),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "select-body" });

    const attempted = await controller.respond(draft.id, "Select the HTTP response body.");

    expect(calls).toBe(2);
    expect(attempted.diagnostics).not.toEqual([]);

    const result = await controller.retry(draft.id);

    expect(calls).toBe(3);
    expect(result.diagnostics).toEqual([]);
    const feedback = result.messages.find(
      (message) =>
        message.role === "user" && message.content.includes("[Host validation feedback]"),
    )?.content;
    expect(feedback).toContain("JSON Pointer '/' selects a property named");
    expect(feedback).toContain("pointer: /body");
  });

  test("normalizes an unindented presentation block in a creator-generated offline test", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register(textTemplateStep);
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "markdown",
              revision: 1,
              description: "Render Markdown.",
              inputs: { type: "object", properties: {}, additionalProperties: false },
              permissions: {},
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "render",
                  uses: "text.template@1",
                  with: { template: "hello\n", data: {} },
                },
              ],
              outputs: {
                result: { value: "$steps.render.output", schema: { type: "string" } },
              },
              presentation: { output: "result" },
            },
            resources: [
              {
                path: "tests/success.yaml",
                content: [
                  "schema_version: 1",
                  "name: markdown",
                  "mode: mock",
                  "inputs: {}",
                  "mocks: {}",
                  "expect:",
                  "  status: succeeded",
                  "  outputs:",
                  "    result: |",
                  "hello",
                  "",
                ].join("\n"),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "markdown" });

    const result = await controller.respond(draft.id, "Render Markdown.");

    expect(result.diagnostics).toEqual([]);
    expect(JSON.parse(result.output?.resources?.[0]?.content ?? "{}")).toMatchObject({
      expect: { outputs: { result: "hello\n" } },
    });
  });

  test("repairs the Exercise 2 prompt, nested schema typo, and object-item template shape", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register({
      name: "llm.generate",
      version: 1,
      inputSchema: {
        type: "object",
        required: ["prompt", "input", "output_schema"],
        properties: { prompt: { type: "string" }, input: {}, output_schema: { type: "object" } },
        additionalProperties: false,
      },
      outputSchema: {},
      defaultTimeoutMs: 120_000,
      classify: () => ({
        effect: "read-only",
        permissions: { model: true },
        retryable: [],
      }),
      preview: () => "generate",
      execute: async () => resolved({}),
    });
    registry.register(textTemplateStep);
    let calls = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          const repaired = calls > 1;
          const planSchema = {
            type: "object",
            required: ["summary", "actions"],
            properties: {
              summary: { type: "string" },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  required: ["description", "owner", "priority"],
                  properties: {
                    description: { type: "string", minLength: 1 },
                    owner: { type: ["string", "null"] },
                    priority: { enum: ["high", "medium", "low"] },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          };
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "meeting-action-plan",
              revision: 1,
              description: "Render a meeting action plan.",
              inputs: {
                type: "object",
                required: ["meeting"],
                properties: {
                  meeting: {
                    type: "object",
                    required: ["title", "notes", "participants"],
                    properties: {
                      title: { type: "string", minLength: 1 },
                      notes: repaired
                        ? { type: "string", minLength: 1 }
                        : { " type": "string", minLength: 1 },
                      participants: { type: "array", items: { type: "string" } },
                    },
                    additionalProperties: false,
                  },
                  preferences: {
                    type: "object",
                    properties: {
                      maximum_actions: { type: "integer", default: 5 },
                      include_open_questions: { type: "boolean", default: true },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
              permissions: { model: true },
              execution: { timeout: "5m" },
              steps: [
                {
                  id: "generate",
                  uses: "llm.generate@1",
                  with: {
                    prompt: repaired
                      ? "Create a plan and obey the maximum_actions field in the input."
                      : "Create at most {{inputs.preferences.maximum_actions}} actions.",
                    input: "$inputs",
                    output_schema: planSchema,
                  },
                },
                {
                  id: "render",
                  uses: "text.template@1",
                  with: repaired
                    ? {
                        data: {
                          title: "$inputs.meeting.title",
                          plan: "$steps.generate.output",
                        },
                        template:
                          "# {{title}}\n{{plan.summary}}\n{{#each plan.actions}}- {{this.description}} / {{this.owner}} / {{this.priority}}\n{{/each}}",
                      }
                    : {
                        data: { inputs: "$inputs", steps: "$steps" },
                        template:
                          "# {{inputs.meeting.title}}\n{{steps.generate.output.summary}}\n{{#each steps.generate.output.actions}}- {{this.description}}\n{{/each}}",
                      },
                },
              ],
              outputs: {
                brief: { value: "$steps.render.output", schema: { type: "string" } },
              },
              presentation: { output: "brief" },
            } as WorkflowManifest,
            resources: [
              {
                path: "tests/success.yaml",
                content: [
                  "schema_version: 1",
                  "name: meeting plan",
                  "mode: mock",
                  "inputs:",
                  "  meeting:",
                  "    title: Review",
                  "    notes: Done",
                  "    participants: [Sam]",
                  "mocks:",
                  "  generate:",
                  "    output:",
                  "      summary: Done",
                  "      actions:",
                  "        - { description: Write docs, owner: null, priority: high }",
                  "expect:",
                  "  status: succeeded",
                  "  outputs:",
                  "    brief: |",
                  "      # Review",
                  "      Done",
                  "      - Write docs / null / high",
                  "",
                ].join("\n"),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "meeting-action-plan" });

    const result = await controller.respond(draft.id, "Create a meeting plan.");

    expect(calls).toBe(2);
    expect(result.diagnostics).toEqual([]);
    const feedback = result.messages.find(
      (message) =>
        message.role === "user" && message.content.includes("[Host validation feedback]"),
    )?.content;
    expect(feedback).toContain("prompt is static");
    expect(feedback).toContain("plan: $steps.llm.output");
    const inputProperties = result.output?.manifest?.inputs.properties as
      | Record<string, WorkflowManifest["inputs"]>
      | undefined;
    const meeting = inputProperties?.meeting;
    const meetingProperties = meeting?.properties as
      | Record<string, WorkflowManifest["inputs"]>
      | undefined;
    expect(meetingProperties?.notes?.type).toBe("string");
  });

  test("repairs malformed generated tests and normalizes an LLM mock result envelope", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register({
      name: "llm.generate",
      version: 1,
      inputSchema: {
        type: "object",
        required: ["prompt", "input", "output_schema"],
        properties: { prompt: { type: "string" }, input: {}, output_schema: { type: "object" } },
        additionalProperties: false,
      },
      outputSchema: {},
      defaultTimeoutMs: 120_000,
      classify: () => ({
        effect: "read-only",
        permissions: { model: true },
        retryable: [],
      }),
      preview: () => "generate",
      execute: async () => resolved({ summary: "Done" }),
    });
    let calls = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          const manifest = {
            schema_version: 1,
            name: "meeting-plan",
            revision: 1,
            description: "Create a meeting plan.",
            inputs: {
              type: "object",
              required: ["notes"],
              properties: {
                notes: { " type": "string", minLength: 1 },
              },
              additionalProperties: false,
            },
            permissions: { model: true },
            execution: { timeout: "5m" },
            steps: [
              {
                id: "generate",
                uses: "llm.generate@1",
                with: {
                  prompt: "Summarize the notes field.",
                  input: "$inputs",
                  output_schema: {
                    type: "object",
                    required: ["summary"],
                    properties: { summary: { type: "string" } },
                    additionalProperties: false,
                  },
                },
              },
            ],
            outputs: {
              plan: {
                value: "$steps.generate.output",
                schema: {
                  type: "object",
                  required: ["summary"],
                  properties: { summary: { type: "string" } },
                  additionalProperties: false,
                },
              },
            },
            presentation: { output: "plan" },
          } as WorkflowManifest;
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest,
            resources: [
              {
                path: "tests/mock-success.yaml",
                content:
                  calls === 1
                    ? [
                        "schema_version: 1",
                        "name: meeting plan",
                        "inputs:",
                        "  notes: Discuss docs",
                        "mocks:",
                        "  generate:",
                        "    output:",
                        "      status: succeeded",
                        "      output:",
                        "        summary: Done",
                        "expect:",
                        "  status: succeeded",
                        "  outputs:",
                        "    plan:",
                        "       summary: Done",
                        "      extra: malformed indentation",
                      ].join("\n")
                    : JSON.stringify({
                        schema_version: 1,
                        name: "meeting plan",
                        mode: "mock",
                        inputs: { notes: "Discuss docs" },
                        mocks: {
                          generate: {
                            output: {
                              status: "succeeded",
                              output: { summary: "Done" },
                            },
                          },
                        },
                        expect: {
                          status: "succeeded",
                          outputs: { plan: { summary: "Done" } },
                        },
                      }),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "meeting-plan" });

    const result = await controller.respond(draft.id, "Create a meeting plan.");

    expect(calls).toBe(2);
    expect(result.diagnostics).toEqual([]);
    expect(
      result.messages.some((message) => message.content.includes("one valid JSON object")),
    ).toBe(true);
    const properties = result.output?.manifest?.inputs.properties as
      | Record<string, WorkflowManifest["inputs"]>
      | undefined;
    const notes = properties?.notes;
    expect(notes?.type).toBe("string");
    const generatedTest = JSON.parse(result.output?.resources?.[0]?.content ?? "{}");
    expect(generatedTest.mocks.generate).toEqual({ output: { summary: "Done" } });
  });

  test("normalizes redundant Markdown spacing around creator each blocks locally", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register(textTemplateStep);
    let calls = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "list",
              revision: 1,
              description: "Render a list.",
              inputs: {
                type: "object",
                required: ["items", "questions"],
                properties: {
                  items: { type: "array", items: { type: "string" } },
                  questions: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
              permissions: {},
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "render",
                  uses: "text.template@1",
                  with: {
                    template:
                      "## Items\n{{#each items}}- {{this}}\n{{/each}}\n\n## Questions\n{{#each questions}}- {{this}}\n{{/each}}\n",
                    data: {
                      items: "$inputs.items",
                      questions: "$inputs.questions",
                    },
                  },
                },
              ],
              outputs: {
                brief: { value: "$steps.render.output", schema: { type: "string" } },
              },
              presentation: { output: "brief" },
            },
            resources: [
              {
                path: "tests/success.yaml",
                content: JSON.stringify({
                  schema_version: 1,
                  name: "list spacing",
                  mode: "mock",
                  inputs: { items: ["One"], questions: ["When?"] },
                  mocks: {},
                  expect: {
                    status: "succeeded",
                    outputs: {
                      brief: "## Items\n- One\n## Questions\n- When?\n",
                    },
                  },
                }),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "list" });

    const result = await controller.respond(draft.id, "Render a list.");

    expect(calls).toBe(1);
    expect(result.diagnostics).toEqual([]);
    const renderWith = result.output?.manifest?.steps[0]?.with as
      | Record<string, unknown>
      | undefined;
    expect(renderWith?.template).toBe(
      "## Items\n{{#each items}}- {{this}}\n{{/each}}\n## Questions\n{{#each questions}}- {{this}}\n{{/each}}",
    );
    const testCase = JSON.parse(result.output?.resources?.[0]?.content ?? "{}");
    expect(testCase.expect.outputs.brief).toBe("## Items\n- One\n\n## Questions\n- When?\n");
  });

  test("repairs a fresh template whose each body starts with a repeated newline", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register(textTemplateStep);
    let calls = 0;
    let repairFeedback = "";
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond(input) {
          calls++;
          if (calls === 2) repairFeedback = input.messages.at(-1)?.content ?? "";
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "list",
              revision: 1,
              description: "Render a list.",
              inputs: {
                type: "object",
                required: ["items"],
                properties: {
                  items: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
              permissions: {},
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "render",
                  uses: "text.template@1",
                  with: {
                    template:
                      calls === 1
                        ? "## Items\n{{#each items}}\n- {{this}}\n{{/each}}"
                        : "## Items\n{{#each items}}- {{this}}\n{{/each}}",
                    data: { items: "$inputs.items" },
                  },
                },
              ],
              outputs: {
                brief: { value: "$steps.render.output", schema: { type: "string" } },
              },
              presentation: { output: "brief" },
            },
            resources: [],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = controller.start({ name: "list" });

    const result = await controller.respond(draft.id, "Render supplied items as Markdown.");

    expect(calls).toBe(2);
    expect(repairFeedback).toContain(
      "a newline immediately after {{#each ...}} becomes part of the repeated body",
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.output?.manifest?.steps[0]?.with).toMatchObject({
      template: "## Items\n{{#each items}}- {{this}}\n{{/each}}",
    });
  });

  test("keeps a presentation-only revision narrow and reconciles deterministic blank-line drift", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register(textTemplateStep);
    const baseManifest = {
      schema_version: 1,
      name: "decision-review",
      revision: 1,
      description: "Render a reviewed decision.",
      inputs: {
        type: "object",
        required: ["assumptions"],
        properties: {
          assumptions: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      permissions: {},
      execution: { timeout: "1m" },
      steps: [
        {
          id: "format",
          uses: "text.template@1",
          with: {
            template: "## Assumptions\n{{#each assumptions}}- {{this}}\n{{/each}}",
            data: { assumptions: "$inputs.assumptions" },
          },
        },
      ],
      outputs: {
        final_recommendation: {
          value: "$steps.format.output",
          schema: { type: "string" },
        },
      },
      presentation: { output: "final_recommendation" },
    } as WorkflowManifest;
    let calls = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          return {
            response: "Appended the requested line.",
            phase: "draft",
            manifest: {
              ...baseManifest,
              revision: 2,
              steps: [
                {
                  ...baseManifest.steps[0]!,
                  timeout: "2m",
                  retry: {
                    attempts: 3,
                    when: ["timeout"],
                    backoff: { initial: "1s", multiplier: 2, maximum: "30s" },
                  },
                  with: {
                    template:
                      "## Assumptions\n{{#each assumptions}}- {{this}}\n{{/each}}\n\nhowdy y'all",
                    data: { assumptions: "$inputs.assumptions" },
                  },
                },
              ],
            },
            resources: [
              {
                path: "tests/format-output-mock.yaml",
                content: JSON.stringify({
                  schema_version: 1,
                  name: "format output",
                  mode: "mock",
                  inputs: { assumptions: ["Development resources are available."] },
                  mocks: {},
                  expect: {
                    status: "succeeded",
                    outputs: {
                      final_recommendation:
                        "## Assumptions\n- Development resources are available.\n\nhowdy y'all",
                    },
                  },
                }),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, {
      name: "decision-review",
      targetRevision: 2,
      baseManifest,
      initialMessages: [{ role: "user", content: "[Host revision context]\nPreserve revision 1." }],
    });

    const result = await controller.respond(
      draft.id,
      `At the very end of the final output, print the following line: "howdy y'all"`,
    );

    expect(calls).toBe(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.output?.manifest?.steps[0]?.timeout).toBeUndefined();
    expect(result.output?.manifest?.steps[0]?.retry).toBeUndefined();
    const testCase = JSON.parse(
      result.output?.resources?.find(
        (resource) => resource.path === "tests/format-output-mock.yaml",
      )?.content ?? "{}",
    );
    expect(testCase.expect.outputs.final_recommendation).toBe(
      "## Assumptions\n- Development resources are available.\n\n\nhowdy y'all",
    );
    expect(result.output?.compilerNotes).toContain(
      "Updated deterministic snapshot expectation in tests/format-output-mock.yaml to match rendered presentation whitespace.",
    );
  });

  test("preserves existing revision resources omitted by the creator", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register(textTemplateStep);
    const manifest = {
      schema_version: 1,
      name: "preserved-test",
      revision: 1,
      description: "Render a stable message.",
      inputs: { type: "object", properties: {}, additionalProperties: false },
      permissions: {},
      execution: { timeout: "1m" },
      steps: [
        {
          id: "format",
          uses: "text.template@1",
          with: { template: "Stable", data: {} },
        },
      ],
      outputs: { result: { value: "$steps.format.output", schema: { type: "string" } } },
      presentation: { output: "result" },
    } as WorkflowManifest;
    const existingTest = {
      path: "tests/existing.yaml",
      content: JSON.stringify({
        schema_version: 1,
        name: "existing",
        mode: "mock",
        inputs: {},
        mocks: {},
        expect: { status: "succeeded", outputs: { result: "Stable" } },
      }),
    };
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          return {
            response: "Kept the workflow stable.",
            phase: "draft",
            manifest: { ...manifest, revision: 2 },
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, {
      name: manifest.name,
      targetRevision: 2,
      baseManifest: manifest,
      baseResources: [existingTest],
    });

    const result = await controller.respond(draft.id, "Clarify the description.");

    expect(result.diagnostics).toEqual([]);
    expect(result.output?.resources).toEqual([existingTest]);
  });

  test("removes an impossible terminal newline from a creator offline expectation", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register(textTemplateStep);
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "languages",
              revision: 1,
              description: "Render detected languages.",
              inputs: {
                type: "object",
                required: ["languages"],
                properties: {
                  languages: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
              permissions: {},
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "render",
                  uses: "text.template@1",
                  with: {
                    template: "**Detected languages**: {{#each languages}}{{this}}, {{/each}}",
                    data: { languages: "$inputs.languages" },
                  },
                },
              ],
              outputs: {
                result: { value: "$steps.render.output", schema: { type: "string" } },
              },
              presentation: { output: "result" },
            },
            resources: [
              {
                path: "tests/success.yaml",
                content: JSON.stringify({
                  schema_version: 1,
                  name: "languages",
                  mode: "mock",
                  inputs: { languages: ["ts", "js"] },
                  mocks: {},
                  expect: {
                    status: "succeeded",
                    outputs: { result: "**Detected languages**: ts, js, \n" },
                  },
                }),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "languages" });

    const result = await controller.respond(draft.id, "Render languages.");

    expect(result.diagnostics).toEqual([]);
    const testCase = JSON.parse(result.output?.resources?.[0]?.content ?? "{}");
    expect(testCase.expect.outputs.result).toBe("**Detected languages**: ts, js, ");
  });

  test("materializes required fixture inputs and missing top-level LLM bindings locally", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register({
      name: "llm.generate",
      version: 1,
      inputSchema: {
        type: "object",
        required: ["prompt", "input", "output_schema"],
        properties: { prompt: { type: "string" }, input: {}, output_schema: { type: "object" } },
        additionalProperties: false,
      },
      outputSchema: {},
      defaultTimeoutMs: 120_000,
      classify: () => ({
        effect: "read-only",
        permissions: { model: true },
        retryable: [],
      }),
      preview: () => "generate",
      execute: async () => resolved({ summary: "Done" }),
    });
    let calls = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "meeting-plan",
              revision: 1,
              description: "Create a meeting plan.",
              inputs: {
                type: "object",
                required: ["meeting"],
                properties: {
                  meeting: {
                    type: "object",
                    required: ["notes"],
                    properties: { notes: { type: "string", minLength: 1 } },
                    additionalProperties: false,
                  },
                  preferences: {
                    type: "object",
                    properties: {
                      maximum_actions: { type: "integer", default: 5 },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
              permissions: { model: true },
              execution: { timeout: "5m" },
              steps: [
                {
                  id: "llm",
                  uses: "llm.generate@1",
                  with: {
                    prompt: "Use meeting and preferences to produce a summary.",
                    input: "$inputs.meeting",
                    output_schema: {
                      type: "object",
                      required: ["summary"],
                      properties: { summary: { type: "string" } },
                      additionalProperties: false,
                    },
                  },
                },
              ],
              outputs: {
                plan: {
                  value: "$steps.llm.output",
                  schema: {
                    type: "object",
                    required: ["summary"],
                    properties: { summary: { type: "string" } },
                    additionalProperties: false,
                  },
                },
              },
              presentation: { output: "plan" },
            },
            resources: [
              {
                path: "tests/success.yaml",
                content: JSON.stringify({
                  schema_version: 1,
                  name: "meeting preferences",
                  mode: "mock",
                  inputs: {},
                  mocks: { llm: { output: { summary: "Done" } } },
                  expect: {
                    status: "succeeded",
                    outputs: { plan: { summary: "Done" } },
                  },
                }),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "meeting-plan" });

    const result = await controller.respond(draft.id, "Create a meeting plan.");

    expect(calls).toBe(1);
    expect(result.diagnostics).toEqual([]);
    const llmWith = result.output?.manifest?.steps[0]?.with as Record<string, unknown> | undefined;
    expect(llmWith?.input).toEqual({
      meeting: "$inputs.meeting",
      preferences: "$inputs.preferences",
    });
    const testCase = JSON.parse(result.output?.resources?.[0]?.content ?? "{}");
    expect(testCase.inputs).toEqual({ meeting: { notes: "example" } });
  });

  test("repairs the ex1-2 manifest and fixture failures with concise semantic feedback", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = httpRegistry();
    registry.register(textTemplateStep);
    const mockBody = {
      name: "bun",
      description: "The all-in-one JavaScript runtime.",
      language: "Zig",
      stargazers_count: 100,
      forks_count: 10,
      open_issues_count: 5,
      default_branch: "main",
    };
    const expected =
      "Repository: bun\nDescription: The all-in-one JavaScript runtime.\nPrimary language: Zig\nStars: 100\nForks: 10\nOpen issues: 5\nDefault branch: main";
    let calls = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          calls++;
          const repaired = calls > 1;
          const manifest = {
            schema_version: 1,
            name: "ghget",
            revision: 5,
            description: "Query public GitHub repository metadata.",
            inputs: repaired
              ? {
                  type: "object",
                  properties: {
                    username: { type: "string", minLength: 1 },
                    repo_name: { type: "string", minLength: 1 },
                  },
                  required: ["username", "repo_name"],
                  additionalProperties: false,
                }
              : ({
                  username: { type: "string" },
                  repo_name: { type: "string" },
                } as unknown as WorkflowManifest["inputs"]),
            permissions: {
              network: [{ host: "api.github.com", methods: ["GET"] }],
            },
            execution: { timeout: "60s" },
            steps: [
              {
                id: "fetch-repo",
                uses: "http.request@1",
                with: {
                  url: "https://api.github.com/repos/${inputs.username}/${inputs.repo_name}",
                  method: "GET",
                  response: "json",
                },
              },
              {
                id: "format-output",
                uses: "text.template@1",
                with: repaired
                  ? {
                      template: [
                        "Repository: {{name}}",
                        "Description: {{description}}",
                        "Primary language: {{language}}",
                        "Stars: {{stargazers_count}}",
                        "Forks: {{forks_count}}",
                        "Open issues: {{open_issues_count}}",
                        "Default branch: {{default_branch}}",
                      ].join("\n"),
                      data: "$steps.fetch-repo.output.body",
                    }
                  : {
                      template:
                        "Language: ${steps.fetch-repo.output.body.primary_language || 'N/A'}",
                      data: {},
                    },
              },
            ],
            outputs: {
              summary: {
                value: repaired ? "$steps.format-output.output" : "${steps.format-output.output}",
                schema: { type: "string" },
              },
            },
            presentation: { output: "summary" },
          } as WorkflowManifest;
          return {
            response: repaired ? "Repaired ghget." : "Drafted ghget v5.",
            phase: "draft",
            manifest,
            resources: [
              {
                path: "tests/ghget-mock.yaml",
                content: repaired
                  ? [
                      "schema_version: 1",
                      "name: repository brief",
                      "mode: mock",
                      "inputs:",
                      "  username: oven-sh",
                      "  repo_name: bun",
                      "mocks:",
                      "  fetch-repo:",
                      "    output:",
                      "      status: 200",
                      "      content_type: application/json",
                      "      final_url: https://api.github.com/repos/oven-sh/bun",
                      `      body: ${JSON.stringify(mockBody)}`,
                      "expect:",
                      "  status: succeeded",
                      "  outputs:",
                      "    summary: |-",
                      ...expected.split("\n").map((line) => `      ${line}`),
                      "",
                    ].join("\n")
                  : [
                      "schema_version: 1",
                      "name: ghget-mock",
                      "mocks:",
                      "  fetch-repo:",
                      "    status: 200",
                      "    content_type: application/json",
                      "    final_url: https://api.github.com/repos/example/test-repo",
                      `    body: ${JSON.stringify(mockBody)}`,
                      "expect:",
                      "  status: succeeded",
                      "",
                    ].join("\n"),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "ghget" });

    const result = await controller.respond(
      draft.id,
      "Query public repository information and display a brief.",
    );

    expect(calls).toBe(2);
    expect(result.diagnostics).toEqual([]);
    expect(result.output?.manifest?.revision).toBe(1);
    expect(result.output?.manifest?.steps[1]?.with).toMatchObject({
      data: "$steps.fetch-repo.output.body",
    });
    const feedback = result.messages.find(
      (message) =>
        message.role === "user" && message.content.includes("[Host validation feedback]"),
    )?.content;
    expect(feedback).toContain(
      "named workflow input 'username' must be declared under inputs.properties",
    );
    expect(feedback).toContain("does not support executable fallback expressions");
    expect(feedback).toContain("expect.outputs.summary");
    expect(feedback).not.toContain('"code":');
  });

  test("blocks activation when a nominal draft still contains unresolved questions", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          return {
            response: "Draft created.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "weather",
              revision: 1,
              description: "Fetch weather.",
              inputs: { type: "object", properties: {} },
              permissions: {},
              execution: { timeout: "1m" },
              steps: [],
              outputs: {},
            },
            assumptions: [],
            unresolvedQuestions: ["Which weather API should be used?"],
          };
        },
      },
      "Interview.",
      {} as never,
    );
    const draft = startLegacy(controller, store, { name: "weather" });

    const result = await controller.respond(draft.id, "Create the weather workflow.");

    expect(result.phase).toBe("questions");
    expect(result.output?.unresolvedQuestions).toEqual(["Which weather API should be used?"]);
  });

  test("persists the attempted message and a recoverable failure before surfacing the error", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    let fail = true;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          if (fail) {
            throw new WorkflowCreatorResponseError("provider cancelled the request", {
              initial: '{"response":"bad initial"}',
              repair: '{"response":"bad repair"}',
            });
          }
          return {
            response: "What result should the workflow produce?",
            phase: "questions",
            assumptions: [],
            unresolvedQuestions: ["result"],
          };
        },
      },
      "Interview.",
      {} as never,
    );
    const draft = startLegacy(controller, store, {
      name: "weather",
      scope: "project",
      sessionId: "session-one",
    });

    await expect(controller.respond(draft.id, "Fetch the Wilmette forecast.")).rejects.toThrow(
      "provider cancelled",
    );
    expect(store.get(draft.id)).toMatchObject({
      phase: "failed",
      lastError: "provider cancelled the request",
      attemptedResponses: {
        initial: '{"response":"bad initial"}',
        repair: '{"response":"bad repair"}',
      },
      messages: [{ role: "user", content: "Fetch the Wilmette forecast." }],
    });
    expect(controller.latest("session-one")?.id).toBe(draft.id);

    fail = false;
    const recovered = await controller.retry(draft.id);
    expect(recovered.phase).toBe("questions");
    expect(recovered.lastError).toBeUndefined();
    expect(recovered.attemptedResponses).toBeUndefined();
    expect(recovered.messages.at(-1)).toEqual({
      role: "assistant",
      content: "What result should the workflow produce?",
    });
  });

  test("automatically repairs host validation errors before returning the draft", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register({
      name: "fake.transform",
      version: 1,
      inputSchema: {
        type: "object",
        required: ["input", "output_schema"],
        properties: { input: {}, output_schema: { type: "object" } },
        additionalProperties: false,
      },
      outputSchema: {},
      defaultTimeoutMs: 1_000,
      classify: () => ({ effect: "read-only", permissions: {}, retryable: [] }),
      preview: () => "transform",
      execute: async () => resolved("ok"),
    });
    const manifest = (withValue: Record<string, unknown>): WorkflowManifest =>
      ({
        schema_version: 1,
        name: "weather",
        revision: 1,
        description: "Summarize weather.",
        inputs: { type: "object", properties: {}, additionalProperties: false },
        permissions: {},
        execution: { timeout: "1m" },
        steps: [{ id: "transform", uses: "fake.transform@1", with: withValue }],
        outputs: {
          result: { value: "$steps.transform.output", schema: { type: "string" } },
        },
      }) as WorkflowManifest;
    let attempt = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          attempt++;
          return {
            response: attempt === 1 ? "Draft ready." : "I corrected the technical manifest.",
            phase: "draft",
            manifest:
              attempt === 1
                ? manifest({})
                : manifest({ input: { value: 1 }, output_schema: { type: "string" } }),
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "weather", sessionId: "session-one" });

    const repaired = await controller.respond(draft.id, "Summarize the weather.");

    expect(attempt).toBe(2);
    expect(repaired.diagnostics).toEqual([]);
    expect(repaired.output?.response).toBe("I corrected the technical manifest.");
    expect(
      repaired.messages.some((message) => message.content.includes("[Host validation feedback]")),
    ).toBe(true);
  });

  test("retry locally repairs a persisted self-contained LLM draft after creator repair fails", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const registry = new WorkflowStepRegistry();
    registry.register({
      name: "llm.generate",
      version: 1,
      inputSchema: {
        type: "object",
        required: ["prompt", "input", "output_schema"],
        properties: { prompt: { type: "string" }, input: {}, output_schema: { type: "object" } },
        additionalProperties: false,
      },
      outputSchema: {},
      defaultTimeoutMs: 1_000,
      classify: () => ({ effect: "read-only", permissions: { model: true }, retryable: [] }),
      preview: () => "generate",
      execute: async () => resolved({ joke: "A joke." }),
    });
    let attempts = 0;
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          attempts++;
          if (attempts > 1) throw new Error("workflow creator returned invalid JSON");
          return {
            response: "Draft ready.",
            phase: "draft",
            manifest: {
              schema_version: 1,
              name: "joke",
              revision: 1,
              description: "Tell a joke.",
              inputs: { type: "object", properties: {}, additionalProperties: false },
              permissions: { model: true },
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "generate",
                  uses: "llm.generate@1",
                  with: {
                    prompt: "Tell a general-audience joke.",
                    output_schema: {
                      type: "object",
                      required: ["joke"],
                      properties: { joke: { type: "string" } },
                      additionalProperties: false,
                    },
                  },
                },
              ],
              outputs: {
                joke: {
                  value: "$steps.generate.output.joke",
                  schema: { type: "string" },
                },
              },
              presentation: { output: "joke" },
            },
            resources: [
              {
                path: "tests/success.yaml",
                content: [
                  "schema_version: 1",
                  "name: joke",
                  "mode: mock",
                  "mocks:",
                  "  generate:",
                  "    output:",
                  "      joke: A joke.",
                  "expect:",
                  "  status: succeeded",
                  "  outputs:",
                  "    joke: A joke.",
                  "",
                ].join("\n"),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create strict workflows.",
      registry,
    );
    const draft = startLegacy(controller, store, { name: "joke", sessionId: "session-one" });
    const legacyDraft = store.get(draft.id)!;
    legacyDraft.creationProtocol = undefined;
    legacyDraft.requirementMessages = undefined;
    store.save(legacyDraft);

    await expect(controller.respond(draft.id, "Tell me a joke. No inputs.")).rejects.toThrow(
      "invalid JSON",
    );
    const recovered = await controller.retry(draft.id);

    expect(attempts).toBe(2);
    expect(recovered.phase).toBe("draft");
    expect(recovered.diagnostics).toEqual([]);
    expect(recovered.output?.manifest?.steps[0]?.with).toMatchObject({ input: null });
  });
});
