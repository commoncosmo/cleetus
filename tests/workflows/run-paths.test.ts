import { expect, it } from "bun:test";
import { workflowArtifactDir, workflowRunDbPath } from "../../src/workflows/run-paths";

it("resolves project and loose workflow storage paths", () => {
  expect(workflowRunDbPath({ projectDir: "/p", configDir: "/g" })).toBe("/p/.cleetus/workflows.db");
  expect(workflowRunDbPath({ configDir: "/g" })).toBe("/g/workflows.db");
  expect(workflowArtifactDir({ projectDir: "/p", configDir: "/g", runId: "r" })).toBe(
    "/p/.cleetus/workflow-runs/r/artifacts",
  );
});
