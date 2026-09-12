import { describe, expect, test } from "bun:test";
import { applyWorkflowInputDefaults } from "../../src/workflows/service";

describe("applyWorkflowInputDefaults", () => {
  const schema = {
    type: "object",
    properties: {
      meeting: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
      },
      preferences: {
        type: "object",
        properties: {
          maximum_actions: { type: "integer", default: 5 },
          include_open_questions: { type: "boolean", default: true },
        },
      },
    },
  };

  test("materializes an omitted optional object that contains nested defaults", () => {
    expect(applyWorkflowInputDefaults(schema, { meeting: { title: "Review" } })).toEqual({
      meeting: { title: "Review" },
      preferences: {
        maximum_actions: 5,
        include_open_questions: true,
      },
    });
  });

  test("preserves supplied nested values and fills only missing defaults", () => {
    expect(
      applyWorkflowInputDefaults(schema, {
        meeting: { title: "Review" },
        preferences: { maximum_actions: 2 },
      }),
    ).toEqual({
      meeting: { title: "Review" },
      preferences: {
        maximum_actions: 2,
        include_open_questions: true,
      },
    });
  });
});
