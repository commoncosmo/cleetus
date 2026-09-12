import { describe, expect, test } from "bun:test";
import { detectWorkflowCreationIntent } from "../../../src/workflows/creator/intent";

describe("workflow creation intent", () => {
  test("matches only narrow natural and slash creation requests", () => {
    expect(detectWorkflowCreationIntent("I want to create a workflow")).toEqual({});
    expect(detectWorkflowCreationIntent("Create a workflow called weather-brief")).toEqual({
      name: "weather-brief",
    });
    expect(detectWorkflowCreationIntent('Create a workflow called "weather"')).toEqual({
      name: "weather",
    });
    expect(detectWorkflowCreationIntent("Create a workflow named “weather-brief”")).toEqual({
      name: "weather-brief",
    });
    expect(detectWorkflowCreationIntent("/workflow create weather-brief")).toEqual({
      name: "weather-brief",
    });
    expect(detectWorkflowCreationIntent('/workflow create "weather"')).toEqual({
      name: "weather",
    });
    expect(
      detectWorkflowCreationIntent("Let's discuss how workflows compare to skills"),
    ).toBeNull();
    expect(detectWorkflowCreationIntent("Update the workflow docs")).toBeNull();
  });
});
