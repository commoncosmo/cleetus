import { describe, expect, test } from "bun:test";
import { renderWorkflowPromptHint } from "../../src/workflows/prompt";

describe("renderWorkflowPromptHint", () => {
  test("advertises workflows separately with explicit-invocation guidance", () => {
    const hint = renderWorkflowPromptHint([
      {
        name: "weather",
        description: "Summarize Wilmette weather",
        manifest: {
          inputs: {
            type: "object",
            properties: {
              city: { type: "string" },
              days: { type: "integer", default: 7 },
            },
            required: ["city"],
          },
        },
      },
    ] as never);
    expect(hint).toContain("/workflow run weather");
    expect(hint).toContain("inputs: city:string required, days:integer optional");
    expect(hint).toContain("only when the user explicitly requests");
    expect(hint).toContain("separate from skills");
  });
});
