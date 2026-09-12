import { describe, expect, test } from "bun:test";
import { resolved } from "../../../src/workflows/provenance";
import {
  renderWorkflowTemplate,
  textTemplateStep,
} from "../../../src/workflows/steps/text-template";

describe("text.template@1", () => {
  test("renders deterministic escaped interpolation and arrays", () => {
    expect(
      renderWorkflowTemplate("Hello {{name}}\n{{#each rows}}- {{this}}\n{{/each}}", {
        name: "<Sam>",
        rows: ["one", "two"],
      }),
    ).toBe("Hello &lt;Sam&gt;\n- one\n- two\n");
  });

  test("renders safe fields from the current object inside each", () => {
    expect(
      renderWorkflowTemplate(
        "{{#each actions}}- {{this.description}} ({{this.priority}}), owner: {{this.owner}}\n{{/each}}",
        {
          actions: [
            { description: "Write docs", priority: "high", owner: "<Sam>" },
            { description: "Investigate", priority: "medium", owner: null },
          ],
        },
      ),
    ).toBe("- Write docs (high), owner: &lt;Sam&gt;\n- Investigate (medium), owner: null\n");
  });

  test("rejects missing values, raw expressions, and executable directives", () => {
    expect(() => renderWorkflowTemplate("{{missing}}", {})).toThrow("missing");
    expect(() => renderWorkflowTemplate("{{{raw}}}", { raw: "x" })).toThrow("raw");
    expect(() => renderWorkflowTemplate("{{#if x}}yes{{/if}}", { x: true })).toThrow("unsupported");
  });

  test("preserves sensitive provenance", async () => {
    const output = await textTemplateStep.execute(
      resolved({ template: "{{value}}", data: { value: "secret" } }, { sensitive: true }),
      { signal: new AbortController().signal, runId: "run", workspace: "/work" },
    );
    expect(output.value).toBe("secret");
    expect(output.provenance.sensitive).toBe(true);
  });
});
