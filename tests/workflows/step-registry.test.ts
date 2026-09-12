import { describe, expect, it } from "bun:test";
import { resolved } from "../../src/workflows/provenance";
import { WorkflowStepRegistry, type WorkflowStepType } from "../../src/workflows/step-registry";

const fake: WorkflowStepType = {
  name: "fake.read",
  version: 1,
  inputSchema: { type: "object" },
  outputSchema: { type: "string" },
  defaultTimeoutMs: 1_000,
  classify: () => ({ effect: "read-only", permissions: {}, retryable: [] }),
  preview: () => "fake",
  execute: async () => resolved("ok"),
};

describe("WorkflowStepRegistry", () => {
  it("registers and lists pinned step versions", () => {
    const registry = new WorkflowStepRegistry();
    registry.register(fake);
    expect(registry.get("fake.read@1")).toBe(fake);
    expect(registry.list()).toEqual([fake]);
  });

  it("rejects duplicate registrations and missing requirements", () => {
    const registry = new WorkflowStepRegistry();
    registry.register(fake);
    expect(() => registry.register(fake)).toThrow("duplicate");
    expect(() => registry.require("fake.read@2")).toThrow("not available");
  });
});
