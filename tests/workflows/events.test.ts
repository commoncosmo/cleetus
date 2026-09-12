import { describe, expect, test } from "bun:test";
import { WorkflowEventLogAdapter, emitWorkflowEvent } from "../../src/workflows/events";

describe("workflow events", () => {
  test("adapts lifecycle events to the existing event stream", () => {
    const appended: unknown[] = [];
    const adapter = new WorkflowEventLogAdapter(
      {
        append(input) {
          appended.push(input);
          return { ...input, id: "event", ts: 1 };
        },
      },
      "session",
    );
    adapter.emit({ type: "run_status", runId: "run", status: "running" });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      sessionId: "session",
      type: "workflow_status",
      payload: {
        workflowEvent: { type: "run_status", runId: "run", status: "running" },
      },
    });
  });

  test("ignores mirror failures", async () => {
    await expect(
      emitWorkflowEvent(
        {
          emit() {
            throw new Error("mirror unavailable");
          },
        },
        { type: "run_status", runId: "run", status: "succeeded" },
      ),
    ).resolves.toBeUndefined();
  });
});
