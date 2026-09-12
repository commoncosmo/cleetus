import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowPackage } from "../../src/workflows/package";
import { resolved } from "../../src/workflows/provenance";
import { WorkflowSchemaService } from "../../src/workflows/schema";
import { WorkflowStepRegistry, type WorkflowStepType } from "../../src/workflows/step-registry";
import { createAssertSchemaStep } from "../../src/workflows/steps/assert-schema";
import { dataSelectStep } from "../../src/workflows/steps/data-select";
import { validateWorkflowPackage } from "../../src/workflows/validate";

const read: WorkflowStepType = {
  name: "fake.read",
  version: 1,
  inputSchema: { type: "object", required: ["value"], properties: { value: {} } },
  outputSchema: { type: "object" },
  defaultTimeoutMs: 1_000,
  classify: () => ({ effect: "read-only", permissions: {}, retryable: ["timeout"] }),
  preview: () => "read",
  execute: async () => resolved({ ok: true }),
};

const transform: WorkflowStepType = {
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
};

const httpEnvelope: WorkflowStepType = {
  name: "fake.http",
  version: 1,
  inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
  outputSchema: {
    type: "object",
    required: ["status", "body"],
    properties: {
      status: { type: "integer" },
      body: {},
    },
    additionalProperties: false,
  },
  defaultTimeoutMs: 1_000,
  classify: () => ({ effect: "read-only", permissions: {}, retryable: [] }),
  preview: () => "GET example.test",
  execute: async () => resolved({ status: 200, body: { results: [] } }),
};

function pkg(steps: string, extras = "", inputs = "{ type: object }") {
  const parent = mkdtempSync(join(tmpdir(), "wf-validate-"));
  const dir = join(parent, "flow");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "workflow.yaml"),
    `
schema_version: 1
name: flow
revision: 1
description: Flow
inputs: ${inputs}
secrets:
  token: { source: env, name: TOKEN }
permissions: {}
execution: { timeout: 1m }
steps:
${steps}
outputs:
  result:
    value: $steps.last.output
    schema: { type: object }
${extras}
`,
  );
  return loadWorkflowPackage(dir, "project");
}

describe("validateWorkflowPackage", () => {
  it("builds a normalized plan for backward references", () => {
    const registry = new WorkflowStepRegistry();
    registry.register(read);
    const result = validateWorkflowPackage(
      pkg(`
  - id: first
    uses: fake.read@1
    with: { value: 1 }
  - id: last
    uses: fake.read@1
    retry:
      attempts: 1
      backoff: { initial: 1s, multiplier: 2, maximum: 2s }
      when: [timeout]
    with: { value: "$steps.first.output" }`),
      registry,
    );
    expect(result.issues).toEqual([]);
    expect(result.plan).toMatchObject({ workflowTimeoutMs: 60_000, maximumAttempts: 3 });
  });

  it("rejects forward references, missing types, and undeclared secrets", () => {
    const registry = new WorkflowStepRegistry();
    registry.register(read);
    const result = validateWorkflowPackage(
      pkg(`
  - id: first
    uses: fake.read@1
    with: { value: "$steps.last.output" }
  - id: middle
    uses: missing.step@1
    with: { value: "$secrets.missing" }
  - id: last
    uses: fake.read@1
    with: { value: 1 }`),
      registry,
    );
    expect(result.plan).toBeUndefined();
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain(
      "not an available earlier step",
    );
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain("not available");
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain("not declared");
  });

  it("rejects undeclared model authority even when the LLM input contains a reference", () => {
    const registry = new WorkflowStepRegistry();
    registry.register({
      name: "llm.generate",
      version: 1,
      inputSchema: {
        type: "object",
        required: ["input"],
        properties: { input: {} },
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      defaultTimeoutMs: 1_000,
      classify: () => ({
        effect: "read-only",
        permissions: { model: true },
        retryable: [],
      }),
      preview: () => "Generate",
      execute: async () => resolved({}),
    });
    const result = validateWorkflowPackage(
      pkg(`
  - id: last
    uses: llm.generate@1
    with: { input: "$inputs" }`),
      registry,
    );

    expect(result.plan).toBeUndefined();
    expect(result.issues).toContainEqual({
      path: "steps.0",
      message: "declared permissions do not cover llm.generate@1",
    });
  });

  it("rejects invented handlebars references outside text.template", () => {
    const registry = new WorkflowStepRegistry();
    registry.register(read);
    const result = validateWorkflowPackage(
      pkg(`
  - id: first
    uses: fake.read@1
    with: { value: 1 }
  - id: last
    uses: fake.read@1
    with: { value: "{{steps.first.output}}" }`),
      registry,
    );

    expect(result.plan).toBeUndefined();
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain(
      "unsupported '{{...}}' syntax",
    );
  });

  it("still validates required fields when another field contains a reference", () => {
    const registry = new WorkflowStepRegistry();
    registry.register(read);
    registry.register(transform);
    const result = validateWorkflowPackage(
      pkg(`
  - id: first
    uses: fake.read@1
    with: { value: 1 }
  - id: last
    uses: fake.transform@1
    with: { input: "$steps.first.output" }`),
      registry,
    );

    expect(result.plan).toBeUndefined();
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain(
      "required property 'output_schema'",
    );
  });

  it("rejects a reference to an optional input unless defaults guarantee its presence", () => {
    const registry = new WorkflowStepRegistry();
    registry.register(read);
    const step = `
  - id: last
    uses: fake.read@1
    with: { value: "$inputs.preferences" }`;
    const unsafe = validateWorkflowPackage(
      pkg(
        step,
        "",
        `
  type: object
  properties:
    preferences:
      type: object
      properties:
        maximum_actions: { type: integer }`,
      ),
      registry,
    );
    const defaulted = validateWorkflowPackage(
      pkg(
        step,
        "",
        `
  type: object
  properties:
    preferences:
      type: object
      properties:
        maximum_actions: { type: integer, default: 5 }`,
      ),
      registry,
    );

    expect(unsafe.plan).toBeUndefined();
    expect(unsafe.issues.map((issue) => issue.message).join("\n")).toContain(
      "can be missing at 'preferences'",
    );
    expect(defaulted.issues).toEqual([]);
  });

  it("rejects paths that cannot exist in a declared model output", () => {
    const registry = new WorkflowStepRegistry();
    registry.register(read);
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
      classify: () => ({
        effect: "read-only",
        permissions: {},
        retryable: [],
      }),
      preview: () => "Generate",
      execute: async () => resolved({ choice: "A", description: "Reason" }),
    });
    const result = validateWorkflowPackage(
      pkg(`
  - id: recommend
    uses: llm.generate@1
    with:
      prompt: Recommend one option.
      input: null
      output_schema:
        type: object
        required: [choice, description]
        properties:
          choice: { type: string }
          description: { type: string }
        additionalProperties: false
  - id: last
    uses: fake.read@1
    with: { value: "$steps.recommend.output.output" }`),
      registry,
    );

    expect(result.plan).toBeUndefined();
    expect(result.issues).toContainEqual({
      path: "steps.1.with",
      message:
        "$steps.recommend.output does not contain 'output' according to the declared output schema; use the whole step result when path is empty",
    });
  });

  it("rejects a data.select pointer that cannot match a known step output envelope", () => {
    const registry = new WorkflowStepRegistry();
    registry.register(httpEnvelope);
    registry.register(dataSelectStep);
    const result = validateWorkflowPackage(
      pkg(`
  - id: fetch
    uses: fake.http@1
    with: { url: "https://example.test" }
  - id: last
    uses: data.select@1
    with:
      value: "$steps.fetch.output"
      pointer: /results/0`),
      registry,
    );

    expect(result.plan).toBeUndefined();
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain(
      "cannot match the known output schema",
    );
  });

  it("allows a data.select pointer once it enters an intentionally open response body", () => {
    const registry = new WorkflowStepRegistry();
    registry.register(httpEnvelope);
    registry.register(dataSelectStep);
    const result = validateWorkflowPackage(
      pkg(`
  - id: fetch
    uses: fake.http@1
    with: { url: "https://example.test" }
  - id: last
    uses: data.select@1
    with:
      value: "$steps.fetch.output.body"
      pointer: /results/0`),
      registry,
    );

    expect(result.issues).toEqual([]);
  });

  it("rejects an invalid literal assert.schema schema during package validation", () => {
    const registry = new WorkflowStepRegistry();
    registry.register(read);
    registry.register(createAssertSchemaStep(new WorkflowSchemaService()));
    const result = validateWorkflowPackage(
      pkg(`
  - id: first
    uses: fake.read@1
    with: { value: 1 }
  - id: last
    uses: assert.schema@1
    with:
      value: "$steps.first.output"
      schema:
        type: object
        properties:
          nullable:
            type: [string, integer]`),
      registry,
    );

    expect(result.plan).toBeUndefined();
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain(
      "use allowUnionTypes to allow union type keyword",
    );
  });
});
