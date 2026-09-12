import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowCreatorController } from "../../../src/workflows/creator/controller";
import {
  WORKFLOW_CREATOR_TESTS_SCHEMA,
  compileWorkflowCreatorTests,
} from "../../../src/workflows/creator/creation-tests";
import { WorkflowDraftStore } from "../../../src/workflows/creator/draft-store";
import { parseWorkflowManifest } from "../../../src/workflows/parse";
import { WorkflowSchemaService } from "../../../src/workflows/schema";
import { WorkflowStepRegistry } from "../../../src/workflows/step-registry";
import { dataSelectStep } from "../../../src/workflows/steps/data-select";

function structuredTest() {
  return {
    path: "tests/success.yaml",
    case: {
      schema_version: 1 as const,
      name: "successful example",
      mode: "mock" as const,
      inputs: {},
      mocks: [
        {
          step: "fetch",
          uses: "http.request@1" as const,
          response: {
            status: 200,
            content_type: "application/json",
            final_url: "https://example.test/data",
            body: { ok: true },
          },
        },
      ],
      expect: {
        status: "succeeded" as const,
        outputs: { result: "ok" },
      },
    },
  };
}

describe("structured workflow creator tests", () => {
  test("validates the strict creator contract and serializes canonical test resources", () => {
    const validator = new WorkflowSchemaService().compile(
      WORKFLOW_CREATOR_TESTS_SCHEMA,
      "creator tests",
    );
    expect(validator.validate([structuredTest()])).toEqual([]);

    const resources = compileWorkflowCreatorTests(
      [structuredTest()],
      [{ path: "prompts/summary.md", content: "Summarize.\n" }],
    );
    expect(resources.map((resource) => resource.path)).toEqual([
      "prompts/summary.md",
      "tests/success.yaml",
    ]);
    expect(JSON.parse(resources[1]!.content)).toEqual({
      ...structuredTest().case,
      mocks: {
        fetch: {
          output: {
            status: 200,
            content_type: "application/json",
            final_url: "https://example.test/data",
            body: { ok: true },
          },
        },
      },
    });
  });

  test("rejects malformed mock wrappers and duplicate or unsafe paths", () => {
    const validator = new WorkflowSchemaService().compile(
      WORKFLOW_CREATOR_TESTS_SCHEMA,
      "creator tests",
    );
    const malformed = structuredTest();
    malformed.case.mocks = [
      {
        step: "fetch",
        uses: "http.request@1",
        response: {
          status: 200,
          body: {},
        },
      } as never,
    ];
    expect(validator.validate([malformed])).not.toEqual([]);

    expect(() =>
      compileWorkflowCreatorTests(
        [structuredTest()],
        [{ path: "tests/success.yaml", content: "{}" }],
      ),
    ).toThrow("duplicate workflow resource path");
    expect(() =>
      compileWorkflowCreatorTests([{ ...structuredTest(), path: "tests/../escape.yaml" }], []),
    ).toThrow("unsafe structured workflow test path");
  });

  test("materializes a structured case before package validation and offline execution", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-structured-tests-")));
    const registry = new WorkflowStepRegistry();
    registry.register(dataSelectStep);
    const controller = new WorkflowCreatorController(
      store,
      {
        respond: async () => ({
          response: "Drafted.",
          phase: "draft" as const,
          manifest: {
            schema_version: 1 as const,
            name: "structured-test",
            revision: 99,
            description: "Exercise host-compiled creator tests.",
            inputs: { type: "object", properties: {}, additionalProperties: false },
            permissions: {},
            execution: { timeout: "10s" },
            steps: [
              {
                id: "select",
                uses: "data.select@1",
                with: { value: { ok: true }, pointer: "" },
              },
            ],
            outputs: {
              result: {
                value: "$steps.select.output",
                schema: { type: "object" },
              },
            },
            presentation: { output: "result" },
          },
          tests: [
            {
              path: "tests/success.yaml",
              case: {
                schema_version: 1 as const,
                name: "successful example",
                mode: "mock" as const,
                inputs: {},
                mocks: [],
                expect: {
                  status: "succeeded" as const,
                  outputs: { result: { ok: true } },
                },
              },
            },
          ],
          assumptions: [],
          unresolvedQuestions: [],
        }),
      },
      "",
      registry,
    );

    const draft = controller.start({ name: "structured-test" });
    const result = await controller.respond(draft.id, "Create the deterministic workflow.");

    expect(result.diagnostics).toEqual([]);
    expect(result.output?.manifest?.revision).toBe(1);
    expect(result.output?.resources?.map((resource) => resource.path)).toEqual([
      "tests/success.yaml",
    ]);
    expect(JSON.parse(result.output!.resources![0]!.content)).toEqual({
      schema_version: 1,
      name: "successful example",
      mode: "mock",
      inputs: {},
      mocks: {},
      expect: {
        status: "succeeded",
        outputs: { result: { ok: true } },
      },
    });
  });

  test("constructs canonical HTTP, model, and command mock envelopes", () => {
    const manifest = parseWorkflowManifest(`
schema_version: 1
name: external-mocks
revision: 1
description: Exercise every external mock constructor
inputs: { type: object, properties: {}, additionalProperties: false }
permissions: {}
execution: { timeout: 5m }
steps:
  - id: fetch
    uses: http.request@1
    with: { url: https://example.test/data }
  - id: summarize
    uses: llm.generate@1
    with:
      prompt: Summarize.
      input: $steps.fetch.output.body
      output_schema: { type: string }
  - id: command
    uses: command.run@1
    with: { program: printf, args: ["{}"], output: json }
outputs:
  result: { value: $steps.command.output.stdout, schema: { type: object } }
`);
    const resources = compileWorkflowCreatorTests(
      [
        {
          path: "tests/all-external.yaml",
          case: {
            schema_version: 1,
            name: "all external steps",
            mode: "mock",
            inputs: {},
            mocks: [
              {
                step: "fetch",
                uses: "http.request@1",
                response: {
                  status: 200,
                  content_type: "application/json",
                  final_url: "https://example.test/data",
                  body: { value: 1 },
                },
              },
              {
                step: "summarize",
                uses: "llm.generate@1",
                value: "One value.",
              },
              {
                step: "command",
                uses: "command.run@1",
                stdout: { ok: true },
              },
            ],
            expect: {
              status: "succeeded",
              outputs: { result: { ok: true } },
            },
          },
        },
      ],
      [],
      manifest,
    );

    expect(JSON.parse(resources[0]!.content).mocks).toEqual({
      fetch: {
        output: {
          status: 200,
          content_type: "application/json",
          final_url: "https://example.test/data",
          body: { value: 1 },
        },
      },
      summarize: { output: "One value." },
      command: {
        output: {
          stdout: { ok: true },
          stderr: "",
          exit_code: 0,
          survivors: [],
        },
      },
    });
  });

  test("requires successful cases to mock every external step", () => {
    const manifest = parseWorkflowManifest(`
schema_version: 1
name: missing-mock
revision: 1
description: Require one HTTP mock
inputs: { type: object, properties: {}, additionalProperties: false }
permissions: {}
execution: { timeout: 1m }
steps:
  - id: fetch
    uses: http.request@1
    with: { url: https://example.test/data }
outputs:
  result: { value: $steps.fetch.output.body, schema: {} }
`);

    expect(() =>
      compileWorkflowCreatorTests(
        [
          {
            path: "tests/missing.yaml",
            case: {
              schema_version: 1,
              name: "missing",
              mode: "mock",
              inputs: {},
              mocks: [],
              expect: { status: "succeeded", outputs: { result: {} } },
            },
          },
        ],
        [],
        manifest,
      ),
    ).toThrow("successful case must mock every external step; missing fetch");
  });

  test("fills only declared input defaults and rejects other missing required inputs", () => {
    const manifest = parseWorkflowManifest(`
schema_version: 1
name: defaulted-inputs
revision: 1
description: Exercise fixture defaults
inputs:
  type: object
  required: [topic, tone]
  properties:
    topic: { type: string, minLength: 1 }
    tone: { type: string, default: concise }
  additionalProperties: false
permissions: {}
execution: { timeout: 1m }
steps:
  - id: select
    uses: data.select@1
    with: { value: $inputs, pointer: "" }
outputs:
  result: { value: $steps.select.output, schema: { type: object } }
`);
    const caseWithTopic = {
      path: "tests/defaulted.yaml",
      case: {
        schema_version: 1 as const,
        name: "defaulted",
        mode: "mock" as const,
        inputs: { topic: "workflows" },
        mocks: [],
        expect: {
          status: "succeeded" as const,
          outputs: { result: { topic: "workflows", tone: "concise" } },
        },
      },
    };

    const [compiled] = compileWorkflowCreatorTests([caseWithTopic], [], manifest);
    expect(JSON.parse(compiled!.content).inputs).toEqual({
      topic: "workflows",
      tone: "concise",
    });
    expect(() =>
      compileWorkflowCreatorTests(
        [{ ...caseWithTopic, case: { ...caseWithTopic.case, inputs: {} } }],
        [],
        manifest,
      ),
    ).toThrow("inputs must provide required values without defaults");
  });
});
