import { describe, expect, it } from "bun:test";
import { RequestEscalationTool } from "../../src/tools/request-escalation";

const signal = new AbortController().signal;

describe("RequestEscalationTool", () => {
  it("has no mutates flag and requires a reason argument", () => {
    const tool = new RequestEscalationTool();
    expect(tool.mutates).toBeUndefined();
    expect(tool.parameters).toMatchObject({ required: ["reason"] });
  });

  it("serializes to a short summary including the reason", () => {
    const tool = new RequestEscalationTool();
    expect(tool.serialize({ reason: "this needs careful multi-file reasoning" })).toContain(
      "this needs careful multi-file reasoning",
    );
  });

  it("succeeds with an acknowledgment and no side effects", async () => {
    const tool = new RequestEscalationTool();
    const result = await tool.run(
      { reason: "low confidence in this fix" },
      { projectDir: "/tmp", abortSignal: signal },
    );
    expect(result.ok).toBe(true);
    expect(result.diff).toBeUndefined();
    expect(result.output).toContain("stronger model");
  });
});
