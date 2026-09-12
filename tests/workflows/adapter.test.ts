import { expect, it } from "bun:test";
import { renderWorkflowSkillAdapter } from "../../src/workflows/adapter";
import { parseWorkflowManifest } from "../../src/workflows/parse";

it("renders the deterministic workflow skill adapter", () => {
  const manifest = parseWorkflowManifest(`
schema_version: 1
name: weather
revision: 1
description: Fetch weather
inputs: { type: object }
permissions: {}
execution: { timeout: 1m }
steps:
  - id: render
    uses: text.template@1
    with: { template: ok }
outputs:
  text: { value: "$steps.render.output", schema: { type: string } }
`);
  expect(renderWorkflowSkillAdapter(manifest)).toContain("cleetus-workflow: workflow.yaml");
  expect(renderWorkflowSkillAdapter(manifest)).toContain("/workflow run weather");
  expect(renderWorkflowSkillAdapter(manifest)).toBe(renderWorkflowSkillAdapter(manifest));
});
