import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_CREATOR_EXACT_REFERENCE_SCHEMA,
  WORKFLOW_CREATOR_REFERENCE_SCHEMA,
  compileWorkflowCreatorReference,
  compileWorkflowCreatorValue,
} from "../../../src/workflows/creator/creation-references";
import { WorkflowSchemaService } from "../../../src/workflows/schema";

const schemas = new WorkflowSchemaService();

describe("workflow creator references", () => {
  test("compiles every typed exact-reference source", () => {
    expect(compileWorkflowCreatorReference({ ref: "input", path: ["topic"] })).toBe(
      "$inputs.topic",
    );
    expect(
      compileWorkflowCreatorReference({
        ref: "step-output",
        step: "fetch",
        path: ["body", "items"],
      }),
    ).toBe("$steps.fetch.output.body.items");
    expect(
      compileWorkflowCreatorReference({
        ref: "secret",
        secret: "api-token",
        path: [],
      }),
    ).toBe("$secrets.api-token");
    expect(compileWorkflowCreatorReference({ ref: "run", field: "workspace" })).toBe(
      "$run.workspace",
    );
  });

  test("compiles typed references recursively inside step data", () => {
    expect(
      compileWorkflowCreatorValue({
        topic: { ref: "input", path: ["topic"] },
        source: {
          account: {
            ref: "step-output",
            step: "fetch",
            path: ["body"],
          },
        },
      }),
    ).toEqual({
      topic: "$inputs.topic",
      source: {
        account: "$steps.fetch.output.body",
      },
    });
  });

  test("rejects unsafe or malformed typed references", () => {
    const validate = schemas.compile(
      WORKFLOW_CREATOR_REFERENCE_SCHEMA,
      "workflow creator reference",
    ).validate;

    expect(
      validate({
        ref: "step-output",
        step: "fetch",
        path: ["__proto__"],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validate({
        ref: "run",
        field: "unknown",
      }).length,
    ).toBeGreaterThan(0);
  });

  test("accepts typed and legacy exact references but rejects interpolation wrappers", () => {
    const validate = schemas.compile(
      WORKFLOW_CREATOR_EXACT_REFERENCE_SCHEMA,
      "workflow creator exact reference",
    ).validate;

    expect(validate({ ref: "step-output", step: "fetch", path: ["body"] })).toEqual([]);
    expect(validate("$steps.fetch.output.body")).toEqual([]);
    expect(validate("${steps.fetch.output.body}").length).toBeGreaterThan(0);
  });
});
