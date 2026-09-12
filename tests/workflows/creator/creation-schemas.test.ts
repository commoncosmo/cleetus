import { describe, expect, test } from "bun:test";
import { canonicalizeWorkflowCreatorJsonSchema } from "../../../src/workflows/creator/creation-schemas";

describe("workflow creator JSON Schema canonicalization", () => {
  test("trims only known schema keywords and preserves property names", () => {
    expect(
      canonicalizeWorkflowCreatorJsonSchema({
        " type": "object",
        properties: {
          " display name ": {
            " type": "string",
          },
        },
        " custom-key ": true,
      }),
    ).toEqual({
      type: "object",
      properties: {
        " display name ": {
          type: "string",
        },
      },
      " custom-key ": true,
    });
  });

  test("does not overwrite an existing canonical keyword", () => {
    expect(
      canonicalizeWorkflowCreatorJsonSchema({
        type: "string",
        " type": "number",
      }),
    ).toEqual({
      type: "string",
      " type": "number",
    });
  });
});
