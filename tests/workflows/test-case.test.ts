import { describe, expect, test } from "bun:test";
import { parseWorkflowTestCase } from "../../src/workflows/test-case";

describe("parseWorkflowTestCase", () => {
  test("parses strict mock cases and rejects live mode", () => {
    expect(
      parseWorkflowTestCase(`
schema_version: 1
name: success
inputs: {}
mocks:
  fetch: { output: { status: 200 } }
expect: { status: succeeded }
`),
    ).toMatchObject({ name: "success" });
    expect(() =>
      parseWorkflowTestCase(`
schema_version: 1
name: live
mode: live
inputs: {}
mocks: {}
expect: { status: succeeded }
`),
    ).toThrow("WF-D14");
  });

  test("names unsupported strict-schema properties", () => {
    expect(() =>
      parseWorkflowTestCase(
        JSON.stringify({
          schema_version: 1,
          name: "invalid description",
          description: "not supported",
          inputs: {},
          mocks: {},
          expect: { status: "succeeded" },
        }),
        "tests/invalid.yaml",
      ),
    ).toThrow("tests/invalid.yaml: /: unsupported property description");
  });
});
