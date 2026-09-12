import { describe, expect, test } from "bun:test";
import type { ChatOptions, Provider } from "../../../src/providers/types";
import {
  StructuredWorkflowCreatorModel,
  WORKFLOW_CREATOR_BLUEPRINT_OUTPUT_SCHEMA,
  WORKFLOW_REQUIREMENTS_CONTRACT_SCHEMA,
  WorkflowCreatorResponseError,
} from "../../../src/workflows/creator/model";
import type {
  WorkflowRequirementsContract,
  WorkflowRevisionBase,
} from "../../../src/workflows/creator/types";
import { WorkflowModelCallService } from "../../../src/workflows/model-call";
import { parseWorkflowManifest } from "../../../src/workflows/parse";

function readyRequirements(
  overrides: Partial<WorkflowRequirementsContract> = {},
): WorkflowRequirementsContract {
  return {
    phase: "ready",
    response: "Requirements are complete.",
    purpose: "Exercise the workflow creator.",
    desiredResult: "Present a text result.",
    inputFields: [],
    modelSteps: [],
    externalActions: [],
    secrets: [],
    presentation: "Markdown",
    assumptions: [],
    unresolvedQuestions: [],
    ...overrides,
  };
}

function revisionTestBase(): WorkflowRevisionBase {
  return {
    name: "select-one",
    scope: "project",
    revision: 1,
    packageHash: "package-one",
    executionHash: "execution-one",
    manifest: parseWorkflowManifest(`
schema_version: 1
name: select-one
revision: 1
description: Select a value
inputs: { type: object, properties: {}, additionalProperties: false }
permissions: {}
execution: { timeout: 10s }
steps:
  - id: select
    uses: data.select@1
    with: { value: true, pointer: "" }
outputs:
  result: { value: $steps.select.output, schema: {} }
`),
    resources: [],
  };
}

describe("StructuredWorkflowCreatorModel", () => {
  test("uses the revision-only change-set contract for an immutable active base", async () => {
    const requests: ChatOptions[] = [];
    const base = revisionTestBase();
    const response = {
      response: "Revision ready.",
      mode: "revise",
      phase: "draft",
      summary: "Clarify the description",
      changeSet: {
        schemaVersion: 1,
        base: {
          name: base.name,
          scope: base.scope,
          revision: base.revision,
          packageHash: base.packageHash,
          executionHash: base.executionHash,
        },
        summary: "Clarify the description",
        operations: [
          {
            op: "set-description",
            id: "clarify-description",
            rationale: "Use the requested wording",
            description: "Select one value",
          },
        ],
      },
      assumptions: [],
      unresolvedQuestions: [],
    };
    const provider: Provider = {
      async *chat(options) {
        requests.push(options);
        yield { type: "text-delta", text: JSON.stringify(response) };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    const output = await model.respond({
      playbook: "Revise narrowly.",
      messages: [{ role: "user", content: "Clarify the description." }],
      name: base.name,
      scope: base.scope,
      revisionBase: base,
    });

    expect(output).toMatchObject({ mode: "revise", changeSet: { schemaVersion: 1 } });
    expect(output.manifest).toBeUndefined();
    expect(requests[0]?.messages[0]?.content).toContain("Never return a complete manifest");
    expect(requests[0]?.messages[0]?.content).toContain("upsert-output => name, output");
    expect(requests[0]?.messages[0]?.content).toContain(
      "Do not introduce llm.generate@1 for deterministic",
    );
    expect(requests[0]?.messages[1]?.content).toContain("immutable revision 1");
    expect(requests[0]?.responseFormat?.kind).toBe("json");
    const operationItems = (
      requests[0]?.responseFormat?.schema as {
        properties?: {
          changeSet?: {
            properties?: {
              operations?: {
                items?: {
                  oneOf?: unknown;
                  properties?: { op?: { enum?: string[] } };
                };
              };
            };
          };
        };
      }
    )?.properties?.changeSet?.properties?.operations?.items;
    expect(operationItems?.oneOf).toBeUndefined();
    expect(operationItems?.properties?.op?.enum).toContain("upsert-step");
  });

  test("repairs a revision under the same complete revision contract", async () => {
    const requests: ChatOptions[] = [];
    const base = revisionTestBase();
    let attempt = 0;
    const provider: Provider = {
      async *chat(options) {
        requests.push(options);
        attempt++;
        yield {
          type: "text-delta",
          text:
            attempt === 1
              ? JSON.stringify({ response: "incomplete" })
              : JSON.stringify({
                  response: "Revision ready.",
                  mode: "revise",
                  phase: "draft",
                  summary: "Number the output",
                  changeSet: {
                    schemaVersion: 1,
                    base: {
                      name: base.name,
                      scope: base.scope,
                      revision: base.revision,
                      packageHash: base.packageHash,
                      executionHash: base.executionHash,
                    },
                    summary: "Number the output",
                    operations: [
                      {
                        op: "set-description",
                        id: "clarify-output",
                        rationale: "Describe the requested presentation",
                        description: "Select and number one value",
                      },
                    ],
                  },
                  assumptions: [],
                  unresolvedQuestions: [],
                }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    await expect(
      model.respond({
        playbook: "Revise narrowly.",
        messages: [{ role: "user", content: "Number the output." }],
        name: base.name,
        scope: base.scope,
        revisionBase: base,
      }),
    ).resolves.toMatchObject({ phase: "draft", mode: "revise" });
    expect(attempt).toBe(2);
    expect(requests[1]?.responseFormat?.schema).toEqual(requests[0]?.responseFormat?.schema);
  });

  test("uses a fresh tool-free structured call and host-owned playbook", async () => {
    const requests: ChatOptions[] = [];
    const provider: Provider = {
      async *chat(options) {
        requests.push(options);
        yield {
          type: "text-delta",
          text: JSON.stringify({
            response: "What should it be named?",
            phase: "questions",
            assumptions: [],
            unresolvedQuestions: ["name"],
          }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });
    expect(
      await model.respond({
        playbook: "Interview briefly. Never activate.",
        messages: [{ role: "user", content: "Create a workflow" }],
        scope: "project",
      }),
    ).toMatchObject({ phase: "questions" });
    expect(requests[0]?.messages[0]?.content).toContain("Never activate");
    expect(requests[0]?.messages[0]?.content).toContain(
      "Treat a workflow name as an opaque identifier",
    );
    expect(requests[0]?.messages[0]?.content).toContain("must come from explicit user statements");
    expect(requests[0]?.messages[0]?.content).toContain("executor-discriminated entries");
    expect(requests[0]?.messages[0]?.content).toContain(
      "Each successful case must mock every HTTP, model, and command step exactly once",
    );
    expect(requests[0]?.messages[0]?.content).toContain(
      "A non-expected HTTP status fails the step",
    );
    expect(requests[0]?.messages[0]?.content).toContain("text.template@1 does not evaluate ||");
    expect(Object.hasOwn(requests[0]!, "tools")).toBe(false);
    expect(requests[0]?.responseFormat?.kind).toBe("json");
  });

  test("removes provider and model selection from a mixed interview", async () => {
    const provider: Provider = {
      async *chat() {
        yield {
          type: "text-delta",
          text: JSON.stringify({
            response: "Please answer these questions.",
            phase: "questions",
            assumptions: [],
            unresolvedQuestions: [
              "What is the specific purpose of the workflow?",
              "Are there any inputs required?",
              "Which LLM provider and model should be used?",
            ],
          }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    const output = await model.respond({
      playbook: "Interview.",
      messages: [{ role: "user", content: "Create a workflow named joke." }],
      scope: "project",
    });

    expect(output.unresolvedQuestions).toEqual([
      "What is the specific purpose of the workflow?",
      "Are there any inputs required?",
    ]);
    expect(output.assumptions).toContain(
      "LLM steps inherit the active provider and model unless the user explicitly chooses otherwise.",
    );
    expect(output.response).not.toContain("provider");
  });

  test("accepts explicit static LLM input and a named presentation output", async () => {
    const provider: Provider = {
      async *chat() {
        yield {
          type: "text-delta",
          text: JSON.stringify({
            response: "Draft ready.",
            phase: "draft",
            assumptions: [],
            unresolvedQuestions: [],
            manifest: {
              schema_version: 1,
              name: "joke",
              revision: 1,
              description: "Tell a joke.",
              inputs: { type: "object", properties: {}, additionalProperties: false },
              permissions: { model: true },
              execution: { timeout: "3m" },
              steps: [
                {
                  id: "generate",
                  uses: "llm.generate@1",
                  with: {
                    prompt: "Tell a safe general-audience joke.",
                    input: null,
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
                  value: { ref: "step-output", step: "generate", path: ["joke"] },
                  schema: { type: "string" },
                },
              },
              presentation: { output: "joke" },
            },
          }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    const output = await model.respond({
      playbook: "Create strict workflows.",
      messages: [{ role: "user", content: "Create a workflow named joke." }],
      scope: "project",
    });

    expect(output.manifest?.presentation?.output).toBe("joke");
    expect(output.manifest?.steps[0]?.with).toMatchObject({ input: null });
    expect(output.assumptions).not.toContain(
      "A self-contained LLM step with no runtime data receives an explicit null input.",
    );
  });

  test("normalizes underscore step ids and keeps references and offline tests synchronized", async () => {
    let attempt = 0;
    const provider: Provider = {
      async *chat() {
        attempt++;
        yield {
          type: "text-delta",
          text: JSON.stringify({
            response: "Draft ready.",
            phase: "draft",
            assumptions: [],
            unresolvedQuestions: [],
            manifest: {
              schema_version: 1,
              name: "account-brief",
              revision: 1,
              description: "Summarize account data.",
              inputs: { type: "object", properties: {}, additionalProperties: false },
              permissions: {
                network: [{ host: "api.example.com", methods: ["GET"] }],
              },
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "fetch_account",
                  uses: "http.request@1",
                  with: { method: "GET", url: "https://api.example.com/account" },
                },
                {
                  id: "select_private",
                  uses: "data.select@1",
                  with: {
                    value: "$steps.fetch_account.output.body",
                    pointer: "/private",
                    default: 0,
                  },
                },
              ],
              outputs: {
                private: {
                  value: { ref: "step-output", step: "select_private", path: [] },
                  schema: { type: "number" },
                },
              },
              presentation: { output: "private" },
            },
            resources: [
              {
                path: "tests/success.yaml",
                content: [
                  "schema_version: 1",
                  "name: account data",
                  "mode: mock",
                  "inputs: {}",
                  "mocks:",
                  "  fetch_account:",
                  "    output:",
                  "      body:",
                  "        private: 2",
                  "expect:",
                  "  status: succeeded",
                  "  outputs:",
                  "    private: 2",
                  "  attempts:",
                  "    fetch_account: 1",
                  "    select_private: 1",
                ].join("\n"),
              },
            ],
          }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    const output = await model.respond({
      playbook: "Create strict workflows.",
      messages: [{ role: "user", content: "Create an account brief." }],
      scope: "project",
    });

    expect(attempt).toBe(1);
    expect(output.manifest?.steps.map((step) => step.id)).toEqual([
      "fetch-account",
      "select-private",
    ]);
    expect(output.manifest?.steps[1]?.with).toMatchObject({
      value: "$steps.fetch-account.output.body",
    });
    expect(output.manifest?.outputs.private?.value).toEqual({
      ref: "step-output",
      step: "select-private",
      path: [],
    });
    expect(output.resources?.[0]?.content).toContain('"fetch-account"');
    expect(output.resources?.[0]?.content).toContain('"select-private"');
    expect(output.resources?.[0]?.content).not.toContain("fetch_account");
    expect(output.resources?.[0]?.content).not.toContain("select_private");
  });

  test("does not normalize underscore step ids when that would create a collision", async () => {
    const provider: Provider = {
      async *chat() {
        yield {
          type: "text-delta",
          text: JSON.stringify({
            response: "Draft ready.",
            phase: "draft",
            assumptions: [],
            unresolvedQuestions: [],
            manifest: {
              schema_version: 1,
              name: "collision",
              revision: 1,
              description: "Demonstrate an invalid collision.",
              inputs: { type: "object" },
              permissions: {},
              execution: { timeout: "1m" },
              steps: [
                { id: "same_step", uses: "text.template@1", with: { template: "one" } },
                { id: "same-step", uses: "text.template@1", with: { template: "two" } },
              ],
              outputs: {
                result: { value: "$steps.same-step.output", schema: { type: "string" } },
              },
            },
          }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    await expect(
      model.respond({
        playbook: "Create strict workflows.",
        messages: [{ role: "user", content: "Create a collision." }],
        scope: "project",
      }),
    ).rejects.toThrow('steps/0/id: must match pattern "^[a-z0-9]+(?:-[a-z0-9]+)*$"');
  });

  test("preserves explicit whole-input binding when the workflow declares runtime inputs", async () => {
    const provider: Provider = {
      async *chat() {
        yield {
          type: "text-delta",
          text: JSON.stringify({
            response: "Draft ready.",
            phase: "draft",
            assumptions: [],
            unresolvedQuestions: [],
            manifest: {
              schema_version: 1,
              name: "topic-joke",
              revision: 1,
              description: "Tell a joke about a supplied topic.",
              inputs: {
                type: "object",
                required: ["topic"],
                properties: { topic: { type: "string" } },
                additionalProperties: false,
              },
              permissions: { model: true },
              execution: { timeout: "3m" },
              steps: [
                {
                  id: "generate",
                  uses: "llm.generate@1",
                  with: {
                    prompt: "Tell a joke about the supplied topic.",
                    input: "$inputs",
                    output_schema: { type: "string" },
                  },
                },
              ],
              outputs: {
                joke: { value: "$steps.generate.output", schema: { type: "string" } },
              },
            },
          }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    const output = await model.respond({
      playbook: "Create strict workflows.",
      messages: [{ role: "user", content: "Create a topic joke workflow." }],
      scope: "project",
    });

    expect(output.manifest?.steps[0]?.with).toMatchObject({ input: "$inputs" });
  });

  test("repairs an interview that contains only optional content preferences", async () => {
    let attempt = 0;
    const provider: Provider = {
      async *chat() {
        attempt++;
        yield {
          type: "text-delta",
          text: JSON.stringify(
            attempt === 1
              ? {
                  response: "One more question.",
                  phase: "questions",
                  assumptions: [],
                  unresolvedQuestions: [
                    "Should the joke be filtered for specific topics or tones?",
                  ],
                }
              : {
                  response: "Draft ready using ordinary safe defaults.",
                  phase: "draft",
                  assumptions: ["Use a general-audience tone."],
                  unresolvedQuestions: [],
                  manifest: {
                    schema_version: 1,
                    name: "joke",
                    revision: 1,
                    description: "Tell a general-audience joke.",
                    inputs: { type: "object", properties: {}, additionalProperties: false },
                    permissions: {},
                    execution: { timeout: "1m" },
                    steps: [
                      {
                        id: "render",
                        uses: "text.template@1",
                        with: {
                          template: "Why did the workflow cross the road? To get to the next step.",
                          data: {},
                        },
                      },
                    ],
                    outputs: {
                      joke: {
                        value: "$steps.render.output",
                        schema: { type: "string" },
                      },
                    },
                    presentation: { output: "joke" },
                  },
                },
          ),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    const output = await model.respond({
      playbook: "Interview.",
      messages: [
        { role: "user", content: "Create a joke workflow." },
        { role: "assistant", content: "What should it do? Are there inputs?" },
        { role: "user", content: "Tell me a joke. No inputs." },
      ],
      scope: "project",
    });

    expect(attempt).toBe(2);
    expect(output.phase).toBe("draft");
    expect(output.unresolvedQuestions).toEqual([]);
  });

  test("rejects a loose skill-shaped draft before host package writes", async () => {
    const provider: Provider = {
      async *chat() {
        yield {
          type: "text-delta",
          text: JSON.stringify({
            response: "Ready.",
            phase: "draft",
            assumptions: [],
            unresolvedQuestions: [],
            manifest: {
              name: "weather",
              description: "Fetch weather.",
              steps: [{ action: "http_get", url: "https://example.com" }],
            },
          }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    await expect(
      model.respond({
        playbook: "Create strict workflows.",
        messages: [{ role: "user", content: "Create weather." }],
        scope: "project",
      }),
    ).rejects.toThrow("workflow creator returned an invalid response");
  });

  test("rejects executor-incompatible fields during creator decoding", async () => {
    const response = {
      response: "Ready.",
      phase: "draft",
      assumptions: [],
      unresolvedQuestions: [],
      manifest: {
        schema_version: 1,
        name: "strict-http",
        revision: 1,
        description: "Fetch one JSON document.",
        inputs: { type: "object", properties: {}, additionalProperties: false },
        permissions: {
          network: [{ host: "example.test", methods: ["GET"] }],
        },
        execution: { timeout: "1m" },
        steps: [
          {
            id: "fetch",
            uses: "http.request@1",
            with: {
              url: "https://example.test/data",
              response: "json",
              output_schema: { type: "object" },
            },
          },
        ],
        outputs: {
          result: {
            value: "$steps.fetch.output.body",
            schema: { type: "object" },
          },
        },
      },
    };
    const provider: Provider = {
      async *chat() {
        yield { type: "text-delta", text: JSON.stringify(response) };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    await expect(
      model.respond({
        playbook: "Create strict workflows.",
        messages: [{ role: "user", content: "Create one HTTP workflow." }],
        scope: "project",
      }),
    ).rejects.toThrow("automatic JSON repair failed");
  });

  test("resolves the active model selection for each creator turn", async () => {
    const requestedModels: string[] = [];
    const provider: Provider = {
      async *chat(options) {
        requestedModels.push(options.model);
        yield {
          type: "text-delta",
          text: JSON.stringify({
            response: "What is the purpose?",
            phase: "questions",
            assumptions: [],
            unresolvedQuestions: ["purpose"],
          }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    let activeModel = "first";
    const model = new StructuredWorkflowCreatorModel(
      new WorkflowModelCallService(() => provider),
      () => ({ provider: "fake", model: activeModel }),
    );
    const input = {
      playbook: "Interview.",
      messages: [{ role: "user" as const, content: "Create a workflow." }],
      scope: "project" as const,
    };
    await model.respond(input);
    activeModel = "second";
    await model.respond(input);

    expect(requestedModels).toEqual(["first", "second"]);
  });

  test("accepts a fenced creator object emitted in the reasoning channel", async () => {
    const provider: Provider = {
      async *chat() {
        yield {
          type: "reasoning-delta",
          text: `I will return the requested object.
\`\`\`json
${JSON.stringify({
  response: "What should the workflow produce?",
  phase: "questions",
  assumptions: [],
  unresolvedQuestions: ["result"],
})}
\`\`\``,
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "reasoning-model",
    });

    expect(
      await model.respond({
        playbook: "Interview.",
        messages: [{ role: "user", content: "Create a workflow." }],
        scope: "project",
      }),
    ).toMatchObject({
      phase: "questions",
      unresolvedQuestions: ["result"],
    });
  });

  test("wraps a complete fenced root-level manifest without a repair call", async () => {
    let attempt = 0;
    const provider: Provider = {
      async *chat() {
        attempt++;
        yield {
          type: "text-delta",
          text: `\`\`\`json
${JSON.stringify({
  schema_version: 1,
  name: "workspace-inventory",
  revision: 1,
  description: "Inventory the workspace.",
  inputs: { type: "object", properties: {}, additionalProperties: false },
  permissions: {},
  execution: { timeout: "1m" },
  steps: [
    {
      id: "render",
      uses: "text.template@1",
      with: { template: "# Inventory", data: {} },
    },
  ],
  outputs: {
    inventory: { value: "$steps.render.output", schema: { type: "string" } },
  },
  presentation: { output: "inventory" },
  resources: [{ path: "scripts/inventory.ts", content: "console.log('{}');\n" }],
  assumptions: ["The workspace is readable."],
  unresolvedQuestions: [],
})}
\`\`\``,
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    const output = await model.respond({
      playbook: "Create strict workflows.",
      messages: [{ role: "user", content: "Create a workspace inventory." }],
      scope: "project",
    });

    expect(attempt).toBe(1);
    expect(output).toMatchObject({
      response: "Workflow draft recovered for review.",
      phase: "draft",
      assumptions: ["The workspace is readable."],
      unresolvedQuestions: [],
      manifest: {
        name: "workspace-inventory",
        steps: [{ id: "render" }],
      },
      resources: [{ path: "scripts/inventory.ts" }],
    });
  });

  test("does not expose root-manifest or legacy-reference recovery to blueprint-v1", async () => {
    let attempt = 0;
    const provider: Provider = {
      async *chat() {
        attempt++;
        yield {
          type: "text-delta",
          text:
            attempt === 1
              ? JSON.stringify(readyRequirements())
              : attempt === 2
                ? JSON.stringify({
                    schema_version: 1,
                    name: "legacy-root",
                    revision: 1,
                    description: "A legacy root manifest.",
                    inputs: { type: "object", properties: {}, additionalProperties: false },
                    permissions: {},
                    execution: { timeout: "1m" },
                    steps: [
                      {
                        id: "render_result",
                        uses: "text.template@1",
                        with: { template: "ready", data: {} },
                      },
                    ],
                    outputs: {
                      result: {
                        value: "$steps.render_result.output",
                        schema: { type: "string" },
                      },
                    },
                    assumptions: [],
                    unresolvedQuestions: [],
                  })
                : JSON.stringify({
                    response: "What result should the workflow produce?",
                    phase: "questions",
                    assumptions: [],
                    unresolvedQuestions: ["desired result"],
                  }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    expect(
      await model.respond({
        playbook: "Create strict workflows.",
        messages: [{ role: "user", content: "Create it." }],
        scope: "project",
        creationProtocol: "blueprint-v1",
      }),
    ).toMatchObject({ phase: "questions" });
    expect(attempt).toBe(3);
  });

  test("stops before blueprint generation when structured input fields remain ambiguous", async () => {
    const requests: ChatOptions[] = [];
    const provider: Provider = {
      async *chat(options) {
        requests.push(options);
        yield {
          type: "text-delta",
          text: JSON.stringify(
            readyRequirements({
              purpose: "Compare options for a decision.",
              desiredResult: "Present a recommendation and critique.",
              inputFields: [
                {
                  path: ["question"],
                  type: "string",
                  itemType: "none",
                  required: true,
                  description: "Decision question",
                  certainty: "conventional",
                  evidence: "",
                },
                {
                  path: ["options"],
                  type: "array",
                  itemType: "object",
                  required: true,
                  description: "Candidate options",
                  certainty: "conventional",
                  evidence: "",
                },
                {
                  path: ["options", [] as unknown as string, "advantages"],
                  type: "unknown",
                  itemType: "unknown",
                  required: true,
                  description: "Advantages of an option",
                  certainty: "unknown",
                  evidence: "",
                },
                {
                  path: ["constraints"],
                  type: "object",
                  itemType: "none",
                  required: false,
                  description: "Decision constraints",
                  certainty: "conventional",
                  evidence: "",
                },
              ],
              unresolvedQuestions: [],
            }),
          ),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    const output = await model.respond({
      playbook: "Create strict workflows.",
      messages: [{ role: "user", content: "Compare options with advantages and constraints." }],
      name: "decision-review",
      scope: "project",
      creationProtocol: "blueprint-v1",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.responseFormat?.schema).toEqual(WORKFLOW_REQUIREMENTS_CONTRACT_SCHEMA);
    expect(output.phase).toBe("questions");
    expect(output.unresolvedQuestions).toContain(
      "Input field options.[].advantages still needs an explicit value type.",
    );
    expect(output.unresolvedQuestions).toContain("Input object constraints needs declared fields.");
    expect(output.requirementsContract?.purpose).toBe("Compare options for a decision.");
    expect(output.requirementsContract?.inputFields[2]?.path).toEqual([
      "options",
      "[]",
      "advantages",
    ]);
  });

  test("repairs a blueprint that changes an approved nested field type", async () => {
    const requests: ChatOptions[] = [];
    let attempt = 0;
    const contract = readyRequirements({
      purpose: "Review option advantages.",
      desiredResult: "Present a review.",
      inputFields: [
        {
          path: ["options"],
          type: "array",
          itemType: "object",
          required: true,
          description: "Options to review",
          certainty: "conventional",
          evidence: "",
        },
        {
          path: ["options", "[]", "advantages"],
          type: "array",
          itemType: "string",
          required: true,
          description: "Advantages for each option",
          certainty: "explicit",
          evidence: "Each option has an array of advantages.",
        },
      ],
    });
    const blueprint = (advantagesType: "string" | "array") => ({
      response: "Draft ready.",
      phase: "draft",
      assumptions: [],
      unresolvedQuestions: [],
      manifest: {
        schema_version: 1,
        name: "decision-review",
        revision: 1,
        description: "Review option advantages.",
        inputs: {
          type: "object",
          properties: {
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  advantages:
                    advantagesType === "array"
                      ? { type: "array", items: { type: "string" } }
                      : { type: "string" },
                },
                required: ["advantages"],
                additionalProperties: false,
              },
            },
          },
          required: ["options"],
          additionalProperties: false,
        },
        permissions: {},
        execution: { timeout: "1m" },
        steps: [
          {
            id: "render",
            uses: "text.template@1",
            with: { template: "# Review", data: {} },
          },
        ],
        outputs: {
          result: {
            value: { ref: "step-output", step: "render", path: [] },
            schema: { type: "string" },
          },
        },
        presentation: { output: "result" },
      },
    });
    const provider: Provider = {
      async *chat(options) {
        requests.push(options);
        attempt++;
        yield {
          type: "text-delta",
          text:
            attempt === 1
              ? JSON.stringify(contract)
              : JSON.stringify(blueprint(attempt === 2 ? "string" : "array")),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    const output = await model.respond({
      playbook: "Create strict workflows.",
      messages: [{ role: "user", content: "Each option has an array of advantages." }],
      name: "decision-review",
      scope: "project",
      creationProtocol: "blueprint-v1",
    });

    expect(attempt).toBe(3);
    expect(requests[2]?.messages[2]?.content).toContain("requirements require array");
    expect(
      (
        (output.manifest?.inputs.properties as Record<string, { items?: { properties?: unknown } }>)
          .options?.items?.properties as Record<string, { type?: string }>
      ).advantages?.type,
    ).toBe("array");
  });

  test("reuses a complete persisted requirements contract during blueprint retry", async () => {
    const requests: ChatOptions[] = [];
    const provider: Provider = {
      async *chat(options) {
        requests.push(options);
        yield {
          type: "text-delta",
          text: JSON.stringify({
            response: "Draft ready.",
            phase: "draft",
            assumptions: [],
            unresolvedQuestions: [],
            manifest: {
              schema_version: 1,
              name: "retry-check",
              revision: 1,
              description: "Return a deterministic result.",
              inputs: {
                type: "object",
                properties: {
                  constraints: {
                    type: "object",
                    default: {},
                  },
                },
                required: [],
                additionalProperties: false,
              },
              permissions: {},
              execution: { timeout: "1m" },
              steps: [
                {
                  id: "render",
                  uses: "text.template@1",
                  with: { template: "ready", data: {} },
                },
              ],
              outputs: {
                result: {
                  value: { ref: "step-output", step: "render", path: [] },
                  schema: { type: "string" },
                },
              },
              presentation: { output: "result" },
            },
          }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });
    const contract = readyRequirements({
      purpose: "Return a deterministic result.",
      desiredResult: "Present the word ready.",
      inputFields: [
        {
          path: ["constraints"],
          type: "object",
          itemType: "any",
          required: false,
          description: "Optional open constraints",
          certainty: "explicit",
          evidence: "constraints is an optional open object...",
        },
      ],
    });

    const output = await model.respond({
      playbook: "Create strict workflows.",
      messages: [
        { role: "user", content: "Return the word ready." },
        {
          role: "user",
          content:
            "constraints is an optional open\n object permitting arbitrary JSON values and defaults to {}.",
        },
        { role: "user", content: "[Host retry rebase] Rebuild the rejected blueprint." },
      ],
      name: "retry-check",
      scope: "project",
      creationProtocol: "blueprint-v1",
      requirementsContract: contract,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.responseFormat?.schema).toEqual(WORKFLOW_CREATOR_BLUEPRINT_OUTPUT_SCHEMA);
    expect(output.requirementsContract).toEqual(contract);
    expect(
      (output.manifest?.inputs.properties as Record<string, { additionalProperties?: boolean }>)
        .constraints?.additionalProperties,
    ).toBe(true);
  });

  test("rejects named inputs placed directly under the blueprint input schema", async () => {
    let attempt = 0;
    const requests: ChatOptions[] = [];
    const provider: Provider = {
      async *chat(options) {
        requests.push(options);
        attempt++;
        yield {
          type: "text-delta",
          text:
            attempt === 1
              ? JSON.stringify(
                  readyRequirements({
                    purpose: "Review a decision.",
                    desiredResult: "Present a recommendation.",
                  }),
                )
              : attempt === 2
                ? JSON.stringify({
                    response: "Draft ready.",
                    phase: "draft",
                    assumptions: [],
                    unresolvedQuestions: [],
                    manifest: {
                      schema_version: 1,
                      name: "decision-review",
                      revision: 2,
                      description: "Review a decision.",
                      inputs: {
                        question: { type: "string", minLength: 1 },
                        options: { type: "array", items: { type: "object" } },
                      },
                      permissions: {},
                      execution: { timeout: "5m" },
                      steps: [
                        {
                          id: "render",
                          uses: "text.template@1",
                          with: { template: "ready", data: {} },
                        },
                      ],
                      outputs: {
                        result: {
                          value: { ref: "step-output", step: "render", path: [] },
                          schema: { type: "string" },
                        },
                      },
                    },
                  })
                : JSON.stringify({
                    response: "Should advantages and disadvantages be strings or arrays?",
                    phase: "questions",
                    assumptions: [],
                    unresolvedQuestions: ["advantages and disadvantages field types"],
                  }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    expect(
      await model.respond({
        playbook: "Create strict workflows.",
        messages: [{ role: "user", content: "Create a decision review." }],
        scope: "project",
        creationProtocol: "blueprint-v1",
      }),
    ).toMatchObject({ phase: "questions" });
    expect(attempt).toBe(3);
    expect(requests[2]?.messages[2]?.content).toContain(
      "named workflow inputs 'question', 'options' must be declared under inputs.properties",
    );
  });

  test("performs one bounded repair when the first completion has no JSON", async () => {
    let attempt = 0;
    const requests: ChatOptions[] = [];
    const provider: Provider = {
      async *chat(options) {
        requests.push(options);
        attempt++;
        yield {
          type: "text-delta",
          text:
            attempt === 1
              ? JSON.stringify(readyRequirements())
              : attempt === 2
                ? "I was unable to format the response."
                : JSON.stringify({
                    response: "What is its purpose?",
                    phase: "questions",
                    assumptions: [],
                    unresolvedQuestions: ["purpose"],
                  }),
        };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    expect(
      await model.respond({
        playbook: "Interview.",
        messages: [{ role: "user", content: "Create a workflow." }],
        scope: "project",
        creationProtocol: "blueprint-v1",
      }),
    ).toMatchObject({ phase: "questions" });
    expect(attempt).toBe(3);
    expect(requests[0]?.maxOutputTokens).toBe(8_192);
    expect(requests[0]?.responseFormat?.schema).toEqual(WORKFLOW_REQUIREMENTS_CONTRACT_SCHEMA);
    expect(requests[1]?.maxOutputTokens).toBe(16_384);
    expect(requests[2]?.maxOutputTokens).toBe(16_384);
    expect(requests[2]?.responseFormat?.schema).toEqual(WORKFLOW_CREATOR_BLUEPRINT_OUTPUT_SCHEMA);
    expect(requests[2]?.messages[1]?.content).toContain(
      "Discard the previous completion and rebuild one complete workflow blueprint",
    );
    expect(requests[2]?.messages[2]?.content).not.toContain("previousFinalText");
    expect(requests[2]?.messages[2]?.content).toContain('"messages"');
  });

  test("repairs malformed JSON-like final text instead of accepting a nested reasoning object", async () => {
    let attempt = 0;
    const provider: Provider = {
      async *chat() {
        attempt++;
        if (attempt === 1) {
          yield { type: "text-delta", text: '{"response":"Draft","phase":"draft"' };
          yield {
            type: "reasoning-delta",
            text: JSON.stringify({
              response: "Wrong channel",
              phase: "questions",
              assumptions: [],
              unresolvedQuestions: [],
            }),
          };
        } else {
          yield {
            type: "text-delta",
            text: JSON.stringify({
              response: "What is its purpose?",
              phase: "questions",
              assumptions: [],
              unresolvedQuestions: ["purpose"],
            }),
          };
        }
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    expect(
      await model.respond({
        playbook: "Interview.",
        messages: [{ role: "user", content: "Create a workflow." }],
        scope: "project",
      }),
    ).toMatchObject({ response: "What is its purpose?" });
    expect(attempt).toBe(2);
  });

  test("reports channel and finish metadata when automatic repair also fails", async () => {
    const provider: Provider = {
      async *chat() {
        yield { type: "text-delta", text: 'not json password="hunter2"' };
        yield { type: "reasoning-delta", text: "still thinking" };
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const model = new StructuredWorkflowCreatorModel(new WorkflowModelCallService(() => provider), {
      provider: "fake",
      model: "model",
    });

    let caught: unknown;
    try {
      await model.respond({
        playbook: "Interview.",
        messages: [{ role: "user", content: "Create a workflow." }],
        scope: "project",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkflowCreatorResponseError);
    expect((caught as Error).message).toContain(
      "provider=fake, model=model, finish=stop, constrained=true, text=27 chars, reasoning=14 chars",
    );
    expect((caught as WorkflowCreatorResponseError).attemptedResponses).toEqual({
      initial: 'not json password="<redacted>"',
      repair: 'not json password="<redacted>"',
    });
  });
});
