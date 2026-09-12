import { describe, expect, test } from "bun:test";
import { fromText } from "../../../src/ui/tui/editor";
import {
  parseWorkflowInputValue,
  workflowInputViewport,
} from "../../../src/ui/tui/workflow-input-prompt";

describe("workflow input prompt", () => {
  test("accepts and validates a pasted JSON array of structured options", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        required: ["name", "advantages", "disadvantages"],
        properties: {
          name: { type: "string", minLength: 1 },
          advantages: { type: "array", items: { type: "string" } },
          disadvantages: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    };
    const text = JSON.stringify([
      {
        name: "Add revise",
        advantages: ["Explicit lifecycle"],
        disadvantages: ["Larger command surface"],
      },
    ]);

    expect(parseWorkflowInputValue(text, schema)).toEqual(JSON.parse(text));
  });

  test("reports field-schema failures for pasted JSON instead of rejecting all arrays", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    };

    expect(() => parseWorkflowInputValue('[{"advantages":[]}]', schema)).toThrow(
      "must have required property 'name'",
    );
  });

  test("keeps a multiline paste in a bounded viewport containing the cursor", () => {
    const viewport = workflowInputViewport(fromText("one\ntwo\nthree\nfour\nfive"), 40, 3);

    expect(viewport).toEqual({
      rows: ["three", "four", "five"],
      cursorRow: 2,
      cursorCol: 4,
      above: true,
      below: false,
    });
  });
});
