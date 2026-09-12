import { describe, expect, it } from "bun:test";
import { workflowExecutionHash, workflowPackageHash } from "../../src/workflows/hashes";
import { parseWorkflowManifest } from "../../src/workflows/parse";

const manifest = parseWorkflowManifest(`
schema_version: 1
name: x
revision: 1
description: X
inputs: { type: object }
permissions: {}
execution: { timeout: 1m }
steps:
  - id: render
    uses: text.template@1
    with: { template: prompts/p.txt }
outputs:
  value: { value: "$steps.render.output", schema: { type: string } }
`);

describe("workflow hashes", () => {
  it("is stable over file ordering and CRLF", () => {
    const a = workflowPackageHash([
      { path: "b", content: "two\r\n" },
      { path: "a", content: "one\n" },
    ]);
    const b = workflowPackageHash([
      { path: "a", content: "one\r\n" },
      { path: "b", content: "two\n" },
    ]);
    expect(a).toBe(b);
  });

  it("execution hash changes for runtime resources but not tests", () => {
    const base = workflowExecutionHash(manifest, [{ path: "prompts/p.txt", content: "a" }]);
    expect(workflowExecutionHash(manifest, [{ path: "prompts/p.txt", content: "b" }])).not.toBe(
      base,
    );
    const packageA = workflowPackageHash([
      { path: "workflow.yaml", content: "x" },
      { path: "tests/a.yaml", content: "a" },
    ]);
    const packageB = workflowPackageHash([
      { path: "workflow.yaml", content: "x" },
      { path: "tests/a.yaml", content: "b" },
    ]);
    expect(packageA).not.toBe(packageB);
  });
});
