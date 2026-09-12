import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunWorkflowTool } from "../../src/tools/run-workflow";
import { buildWorkflowService } from "../../src/ui/cli/workflow";
import { WorkflowDraftStore } from "../../src/workflows/creator/draft-store";
import { loadWorkflowPackage } from "../../src/workflows/package";

describe("RunWorkflowTool", () => {
  test("delegates exact names and inputs to the shared service", async () => {
    const seen: unknown[] = [];
    const tool = new RunWorkflowTool({
      async run(input: unknown) {
        seen.push(input);
        return {
          run_id: "run",
          workflow: "weather",
          revision: 1,
          execution_hash: "hash",
          status: "succeeded",
          outputs: { summary: "cold" },
        };
      },
    } as never);
    const result = await tool.run(
      { name: "weather", inputs: { city: "Wilmette" } },
      {
        projectDir: "/work",
        abortSignal: new AbortController().signal,
        sessionId: "session",
      },
    );
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      name: "weather",
      inputs: { city: "Wilmette" },
    });
  });

  test("returns structured workflow denial without reconstructing authority", async () => {
    const tool = new RunWorkflowTool({
      async run() {
        throw new Error("workflow execution was denied");
      },
    } as never);
    expect(
      (
        await tool.run(
          { name: "weather" },
          { projectDir: "/work", abortSignal: new AbortController().signal },
        )
      ).errorMessage,
    ).toContain("denied");
  });

  test("inherits the persistent replacement guard used by model and ACP hosts", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-workflow-guard-"));
    const project = join(root, "project");
    const config = join(root, "config");
    const workflowsRoot = join(project, ".cleetus", "workflows");
    const packageDir = join(workflowsRoot, "weather");
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(packageDir, "workflow.yaml"),
      `
schema_version: 1
name: weather
revision: 1
description: Weather
inputs: { type: object, properties: {}, additionalProperties: false }
permissions: {}
execution: { timeout: 10s }
steps:
  - id: value
    uses: data.select@1
    with: { value: mild, pointer: "" }
outputs:
  result: { value: $steps.value.output, schema: {} }
`,
    );
    const pkg = loadWorkflowPackage(packageDir, "project");
    const drafts = new WorkflowDraftStore(workflowsRoot);
    const draft = drafts.create({
      scope: "project",
      name: "weather",
      sessionId: "different-session",
      targetRevision: 2,
    });
    draft.phase = "draft";
    draft.output = {
      response: "Ready",
      phase: "draft",
      manifest: { ...pkg.manifest, revision: 2 },
      assumptions: [],
      unresolvedQuestions: [],
    };
    drafts.save(draft);
    const built = await buildWorkflowService({
      projectDir: project,
      configDir: config,
      execution: false,
    });
    try {
      const tool = new RunWorkflowTool(built.service);
      const result = await tool.run(
        { name: "weather" },
        {
          projectDir: project,
          abortSignal: new AbortController().signal,
          sessionId: "tool-session",
        },
      );

      expect(result).toMatchObject({
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: expect.stringContaining("valid replacement revision 2"),
      });
      expect(existsSync(join(project, ".cleetus", "workflows.db"))).toBe(false);
    } finally {
      await built.dispose();
    }
  });
});
