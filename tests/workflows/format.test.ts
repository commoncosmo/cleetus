import { describe, expect, test } from "bun:test";
import {
  formatWorkflowDryRun,
  formatWorkflowHistory,
  formatWorkflowResult,
  formatWorkflowRunDetail,
} from "../../src/workflows/format";

describe("workflow formatting", () => {
  test("formats bounded dry-run and presentation output", () => {
    expect(
      formatWorkflowDryRun({
        workflow: "weather",
        revision: 1,
        source: "project",
        packageHash: "package",
        executionHash: "execution",
        workflowTimeoutMs: 60_000,
        steps: [
          {
            id: "fetch",
            uses: "http.request@1",
            timeoutMs: 10_000,
            maximumAttempts: 2,
            preview: "GET api.open-meteo.com",
          },
        ],
        preflight: {
          permissions: {
            network: [],
            commands: [],
            filesystem: { read: [], write: [] },
            model: false,
          },
          maximumAttempts: 2,
          maximumModelCalls: 0,
          effect: "read-only",
          requiredSecrets: [],
          unresolved: [],
        },
        summary: "Effect: read-only",
      }),
    ).toContain("1. fetch");
    expect(
      formatWorkflowResult(
        {
          run_id: "run",
          workflow: "weather",
          revision: 1,
          execution_hash: "hash",
          status: "succeeded",
          outputs: { brief: "Cold today." },
        },
        "brief",
      ),
    ).toBe("Cold today.");
    expect(
      formatWorkflowResult(
        {
          run_id: "run",
          workflow: "weather",
          revision: 1,
          execution_hash: "hash",
          status: "succeeded",
          outputs: {
            brief: ["Cold this morning.", "- Mild this afternoon.", "Dry this evening."],
          },
        },
        "brief",
      ),
    ).toBe("- Cold this morning.\n- Mild this afternoon.\n- Dry this evening.");
  });

  test("formats empty and paged history without unbounded loading", () => {
    expect(formatWorkflowHistory([])).toBe("No workflow runs found.");
    expect(
      formatWorkflowHistory([
        {
          id: "run",
          workflowName: "weather",
          revision: 1,
          packageHash: "p",
          executionHash: "e",
          status: "succeeded",
          workspace: "/work",
          inputs: {},
          createdAt: 0,
        },
      ]),
    ).toContain("run  weather@1  succeeded");
  });

  test("formats bounded run details with step attempts and model authority", () => {
    const text = formatWorkflowRunDetail({
      run: {
        id: "run-one",
        workflowName: "decision-review",
        revision: 1,
        packageHash: "package",
        executionHash: "execution",
        status: "succeeded",
        workspace: "/work",
        inputs: {},
        createdAt: 0,
        startedAt: 1_000,
        endedAt: 4_000,
      },
      steps: [
        {
          runId: "run-one",
          stepId: "recommend",
          ordinal: 0,
          uses: "llm.generate@1",
          effect: "read-only",
          status: "succeeded",
          attempts: 1,
          output: { recommendation: "Add revise", detail: "x".repeat(500) },
          startedAt: 1_000,
          endedAt: 4_000,
        },
      ],
      attempts: [
        {
          runId: "run-one",
          stepId: "recommend",
          attempt: 1,
          status: "succeeded",
          startedAt: 1_000,
          endedAt: 4_000,
        },
      ],
      modelAttempts: [
        {
          runId: "run-one",
          stepId: "recommend",
          attempt: 1,
          provider: "local",
          requestedModel: "model-a",
          finishReason: "stop",
          inputTokens: 100,
          outputTokens: 25,
          promptHash: "hash",
          constrained: true,
          startedAt: 1_000,
          endedAt: 4_000,
        },
      ],
    });

    expect(text).toContain("recommend (llm.generate@1) — succeeded · 1 attempt · 3.0s");
    expect(text).toContain("local/model-a · stop · constrained · tokens 100→25");
    expect(text).toContain('"recommendation":"Add revise"');
    expect(text.length).toBeLessThan(1_200);
  });
});
