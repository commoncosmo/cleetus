import { describe, expect, test } from "bun:test";
import { WorkflowModelCallService } from "../../../src/workflows/model-call";
import { resolved } from "../../../src/workflows/provenance";
import { WorkflowSchemaService } from "../../../src/workflows/schema";
import {
  createBuiltinWorkflowStepRegistry,
  createDeterministicWorkflowStepRegistry,
} from "../../../src/workflows/steps";
import { createAssertSchemaStep } from "../../../src/workflows/steps/assert-schema";

describe("assert.schema@1", () => {
  test("returns valid values and rejects invalid values with structured paths", async () => {
    const step = createAssertSchemaStep(new WorkflowSchemaService());
    const context = {
      signal: new AbortController().signal,
      runId: "run",
      workspace: "/work",
    };
    const valid = await step.execute(
      resolved({
        value: { count: 2 },
        schema: {
          type: "object",
          required: ["count"],
          properties: { count: { type: "number" } },
        },
      }),
      context,
    );
    expect(valid.value).toEqual({ count: 2 });
    await expect(
      step.execute(
        resolved({
          value: { count: "two" },
          schema: {
            type: "object",
            required: ["count"],
            properties: { count: { type: "number" } },
          },
        }),
        context,
      ),
    ).rejects.toThrow("/count");
  });

  test("registers exactly the deterministic pinned built-ins", () => {
    expect(
      createDeterministicWorkflowStepRegistry()
        .list()
        .map((step) => `${step.name}@${step.version}`),
    ).toEqual(["assert.schema@1", "data.select@1", "text.template@1"]);
  });

  test("registers exactly the six approved v1 built-ins", () => {
    const registry = createBuiltinWorkflowStepRegistry({
      packageDir: "/work/workflow",
      sandbox: {
        async exec() {
          throw new Error("not called");
        },
        async dispose() {},
        writeRoot: () => null,
      },
      modelCalls: new WorkflowModelCallService(() => {
        throw new Error("not called");
      }),
    });
    expect(registry.list().map((step) => `${step.name}@${step.version}`)).toEqual([
      "assert.schema@1",
      "command.run@1",
      "data.select@1",
      "http.request@1",
      "llm.generate@1",
      "text.template@1",
    ]);
  });
});
