import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_CREATOR_STEP_SCHEMA,
  compileWorkflowCreatorSteps,
} from "../../../src/workflows/creator/creation-steps";
import { WorkflowSchemaService } from "../../../src/workflows/schema";
import type { JsonValue } from "../../../src/workflows/types";

const validate = new WorkflowSchemaService().compile(
  WORKFLOW_CREATOR_STEP_SCHEMA,
  "workflow creator step blueprint",
).validate;

const validSteps: JsonValue[] = [
  {
    id: "fetch",
    uses: "http.request@1",
    with: {
      url: "https://example.test/items",
      method: "GET",
      query: { limit: 10, enabled: true, tag: ["one", "two"] },
      response: "json",
    },
  },
  {
    id: "summarize",
    uses: "llm.generate@1",
    with: {
      prompt: "Summarize the supplied value.",
      input: "$steps.fetch.output.body",
      output_schema: { type: "string" },
    },
  },
  {
    id: "inventory",
    uses: "command.run@1",
    with: {
      program: "bun",
      args: ["run", "./scripts/inventory.ts"],
      output: "json",
    },
  },
  {
    id: "select",
    uses: "data.select@1",
    with: {
      value: "$steps.fetch.output.body",
      pointer: "/items",
      default: [],
    },
  },
  {
    id: "render",
    uses: "text.template@1",
    with: {
      template: "# Result\n\n{{value}}\n",
      data: { value: "$steps.select.output" },
    },
  },
  {
    id: "assert",
    uses: "assert.schema@1",
    with: {
      value: "$steps.select.output",
      schema: { type: "array" },
    },
  },
];

describe("workflow creator step blueprint", () => {
  test("accepts every v1 executor branch", () => {
    for (const step of validSteps) {
      expect(validate(step), JSON.stringify(step)).toEqual([]);
    }
  });

  test("rejects fields from a different executor branch", () => {
    const issues = validate({
      id: "fetch",
      uses: "http.request@1",
      with: {
        url: "https://example.test/items",
        output_schema: { type: "string" },
      },
    });

    expect(issues.length).toBeGreaterThan(0);
  });

  test("requires explicit LLM input and output schema", () => {
    const issues = validate({
      id: "summarize",
      uses: "llm.generate@1",
      with: { prompt: "Summarize this." },
    });

    expect(
      issues.some(
        (issue) => issue.keyword === "required" && issue.message.includes("property 'input'"),
      ),
    ).toBe(true);
    expect(
      issues.some(
        (issue) =>
          issue.keyword === "required" && issue.message.includes("property 'output_schema'"),
      ),
    ).toBe(true);
  });

  test("restricts command output to the runtime enum", () => {
    const issues = validate({
      id: "inventory",
      uses: "command.run@1",
      with: { program: "bun", output: "stdout" },
    });

    expect(issues.length).toBeGreaterThan(0);
  });

  test("compiles to an independent manifest step value", () => {
    const source = validSteps as Parameters<typeof compileWorkflowCreatorSteps>[0];
    const compiled = compileWorkflowCreatorSteps(source);

    expect(compiled).toEqual(source);
    expect(compiled).not.toBe(source);
    expect(compiled[0]?.with).not.toBe(source[0]?.with);
  });
});
