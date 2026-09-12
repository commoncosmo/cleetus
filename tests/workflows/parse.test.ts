import { describe, expect, it } from "bun:test";
import { parseWorkflowManifest } from "../../src/workflows/parse";

const VALID = `
schema_version: 1
name: weather
revision: 1
description: Weather summary
inputs:
  type: object
permissions:
  network:
    - host: api.example.com
      methods: [GET]
  model: true
execution:
  timeout: 5m
steps:
  - id: fetch
    uses: http.request@1
    timeout: 10s
    with:
      url: https://api.example.com
outputs:
  result:
    value: $steps.fetch.output
    schema:
      type: object
presentation:
  output: result
`;

describe("parseWorkflowManifest", () => {
  it("parses a strict valid manifest", () => {
    expect(parseWorkflowManifest(VALID)).toMatchObject({
      schema_version: 1,
      name: "weather",
      revision: 1,
    });
  });

  it("rejects unknown and deferred fields", () => {
    expect(() => parseWorkflowManifest(`${VALID}\nparallel: true\n`)).toThrow("Unrecognized key");
    expect(() => parseWorkflowManifest(VALID.replace("with:", "if: yes\n    with:"))).toThrow(
      "Unrecognized key",
    );
  });

  it("rejects duplicate yaml keys and step ids", () => {
    expect(() => parseWorkflowManifest(`${VALID}\nname: duplicate\n`)).toThrow();
    expect(() =>
      parseWorkflowManifest(
        VALID.replace("outputs:", "  - id: fetch\n    uses: data.select@1\n    with: {}\noutputs:"),
      ),
    ).toThrow("duplicate step id");
  });

  it("rejects unpinned steps and unknown presentation outputs", () => {
    expect(() => parseWorkflowManifest(VALID.replace("http.request@1", "http.request"))).toThrow();
    expect(() => parseWorkflowManifest(VALID.replace("output: result", "output: missing"))).toThrow(
      "is not declared",
    );
  });
});
