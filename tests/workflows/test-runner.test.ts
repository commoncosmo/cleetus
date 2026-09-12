import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowModelCallService } from "../../src/workflows/model-call";
import { loadWorkflowPackage } from "../../src/workflows/package";
import { createBuiltinWorkflowStepRegistry } from "../../src/workflows/steps";
import { parseWorkflowTestCase } from "../../src/workflows/test-case";
import { runWorkflowTestCase } from "../../src/workflows/test-runner";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/workflows/weather-brief",
);
const repositoryFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/workflows/repository-brief",
);

describe("runWorkflowTestCase", () => {
  test("runs external mocks and real deterministic steps without provider/network/sandbox", async () => {
    const pkg = loadWorkflowPackage(fixture, "project");
    const registry = createBuiltinWorkflowStepRegistry({
      packageDir: pkg.dir,
      modelCalls: new WorkflowModelCallService(() => {
        throw new Error("provider must not be called");
      }),
      sandbox: {
        async exec() {
          throw new Error("sandbox must not be called");
        },
        async dispose() {},
        writeRoot: () => null,
      },
      transport: async () => {
        throw new Error("network must not be called");
      },
    });
    const testCase = parseWorkflowTestCase(
      readFileSync(join(fixture, "tests", "success.yaml"), "utf8"),
    );
    expect(await runWorkflowTestCase(pkg, registry, testCase)).toEqual({
      name: "three-bullet weather brief",
      passed: true,
      failures: [],
    });
  });

  test("refuses an external step without a mock", async () => {
    const pkg = loadWorkflowPackage(fixture, "project");
    const registry = createBuiltinWorkflowStepRegistry({
      packageDir: pkg.dir,
      modelCalls: new WorkflowModelCallService(() => {
        throw new Error("not called");
      }),
      sandbox: {
        async exec() {
          throw new Error("not called");
        },
        async dispose() {},
        writeRoot: () => null,
      },
    });
    const testCase = parseWorkflowTestCase(`
schema_version: 1
name: missing mock
inputs: {}
mocks: {}
expect: { status: failed }
`);
    const result = await runWorkflowTestCase(pkg, registry, testCase);
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toContain("no declared mock");
  });

  test("reports the failed deterministic step and bounded expected/actual outputs", async () => {
    const pkg = loadWorkflowPackage(fixture, "project");
    const registry = createBuiltinWorkflowStepRegistry({
      packageDir: pkg.dir,
      modelCalls: new WorkflowModelCallService(() => {
        throw new Error("not called");
      }),
      sandbox: {
        async exec() {
          throw new Error("not called");
        },
        async dispose() {},
        writeRoot: () => null,
      },
    });
    const testCase = parseWorkflowTestCase(`
schema_version: 1
name: actionable failure
inputs: {}
mocks:
  forecast:
    output: { status: 200, content_type: application/json, final_url: https://example.test, body: {} }
  summarize:
    output: { bullets: wrong-shape }
expect:
  status: succeeded
  outputs:
    brief: expected text
`);

    const result = await runWorkflowTestCase(pkg, registry, testCase);

    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      "step 'render' failed: template collection 'bullets' is not an array",
    );
    expect(result.failures).toContain(
      'final outputs did not match: expected {"brief":"expected text"}; received undefined',
    );
  });

  test("applies defaults and rejects missing required fixture inputs before execution", async () => {
    const pkg = loadWorkflowPackage(repositoryFixture, "project");
    const registry = createBuiltinWorkflowStepRegistry({
      packageDir: pkg.dir,
      modelCalls: new WorkflowModelCallService(() => {
        throw new Error("provider must not be called");
      }),
      sandbox: {
        async exec() {
          throw new Error("sandbox must not be called");
        },
        async dispose() {},
        writeRoot: () => null,
      },
      transport: async () => {
        throw new Error("network must not be called");
      },
    });
    const valid = parseWorkflowTestCase(
      readFileSync(join(repositoryFixture, "tests", "success.yaml"), "utf8"),
    );

    const result = await runWorkflowTestCase(pkg, registry, { ...valid, inputs: {} });

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toContain("test inputs failed workflow schema validation");
    expect(result.failures.join("\n")).toContain("required property 'username'");
  });

  test("reports the run-level error when reference resolution fails before a step attempt", async () => {
    const parent = mkdtempSync(join(tmpdir(), "workflow-pre-step-"));
    const dir = join(parent, "pre-step");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "workflow.yaml"),
      `
schema_version: 1
name: pre-step
revision: 1
description: Exercise a pre-step reference failure.
inputs: { type: object, properties: {}, additionalProperties: false }
permissions:
  network:
    - host: example.test
      methods: [GET]
execution: { timeout: 1m }
steps:
  - id: fetch
    uses: http.request@1
    with: { url: "https://example.test/data", method: GET }
  - id: render
    uses: text.template@1
    with:
      template: "{{value}}"
      data: { value: "$steps.fetch.output.body.missing" }
outputs:
  result:
    value: $steps.render.output
    schema: { type: string }
`,
    );
    const pkg = loadWorkflowPackage(dir, "project");
    const registry = createBuiltinWorkflowStepRegistry({
      packageDir: pkg.dir,
      modelCalls: new WorkflowModelCallService(() => {
        throw new Error("provider must not be called");
      }),
      sandbox: {
        async exec() {
          throw new Error("sandbox must not be called");
        },
        async dispose() {},
        writeRoot: () => null,
      },
      transport: async () => {
        throw new Error("network must not be called");
      },
    });
    const testCase = parseWorkflowTestCase(`
schema_version: 1
name: pre-step diagnostic
inputs: {}
mocks:
  fetch:
    output:
      status: 200
      content_type: application/json
      final_url: https://example.test/data
      body: {}
expect:
  status: succeeded
  outputs: { result: unreachable }
`);

    const result = await runWorkflowTestCase(pkg, registry, testCase);

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toContain("workflow failed outside a step attempt");
    expect(result.failures.join("\n")).toContain("does not contain 'missing'");
  });
});
