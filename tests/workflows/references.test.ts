import { describe, expect, it } from "bun:test";
import { resolved } from "../../src/workflows/provenance";
import {
  type WorkflowReferenceContext,
  resolveWorkflowValue,
  workflowReferencesIn,
} from "../../src/workflows/references";

function context(): WorkflowReferenceContext {
  return {
    inputs: resolved(
      { location: "Wilmette", count: 3, nested: { values: ["a", "b"] } },
      { untrusted: true, origins: ["input"] },
    ),
    steps: {
      fetch: {
        output: resolved(
          { body: { hourly: [70, 72] } },
          { untrusted: true, origins: ["step:fetch"] },
        ),
      },
    },
    run: {
      id: "run-1",
      started_at: "2026-07-27T12:00:00Z",
      workspace: "/tmp/project",
    },
    secrets: {
      api_key: resolved("secret-value", { sensitive: true, origins: ["secret:api_key"] }),
    },
    availableSteps: new Set(["fetch"]),
  };
}

describe("resolveWorkflowValue", () => {
  it("preserves the type of whole references", () => {
    const out = resolveWorkflowValue("$inputs.count", context());
    expect(out.value).toBe(3);
    expect(out.provenance.untrusted).toBe(true);
  });

  it("resolves earlier step paths and array indexes", () => {
    expect(resolveWorkflowValue("$steps.fetch.output.body.hourly.1", context()).value).toBe(72);
    expect(resolveWorkflowValue("$inputs.nested.values.0", context()).value).toBe("a");
  });

  it("interpolates scalars and merges provenance", () => {
    const out = resolveWorkflowValue(
      "Forecast for ${inputs.location} in ${run.workspace}",
      context(),
    );
    expect(out.value).toBe("Forecast for Wilmette in /tmp/project");
    expect(out.provenance).toMatchObject({ untrusted: true, sensitive: false });
  });

  it("resolves recursively and propagates secret sensitivity", () => {
    const out = resolveWorkflowValue(
      { header: "Bearer ${secrets.api_key}", count: "$inputs.count" },
      context(),
    );
    expect(out.value).toEqual({ header: "Bearer secret-value", count: 3 });
    expect(out.provenance.sensitive).toBe(true);
  });

  it("rejects composite interpolation and unavailable steps", () => {
    expect(() => resolveWorkflowValue("x=${inputs.nested}", context())).toThrow(
      "scalar values only",
    );
    expect(() =>
      resolveWorkflowValue("$steps.future.output", {
        ...context(),
        availableSteps: new Set(),
      }),
    ).toThrow("not an available earlier step");
  });

  it("rejects missing and unsafe paths without echoing values", () => {
    expect(() => resolveWorkflowValue("$inputs.missing", context())).toThrow(
      "does not contain 'missing'",
    );
    expect(() => resolveWorkflowValue("$inputs.__proto__", context())).toThrow("unsafe path");
  });

  it("discovers whole and interpolated references using runtime syntax", () => {
    expect(
      workflowReferencesIn({
        whole: "$secrets.query_key",
        interpolated: "Bearer ${secrets.header_token}",
        input: "${inputs.location}",
        literal: "embedded $secrets.not_a_reference",
      }),
    ).toEqual([
      { namespace: "secrets", path: ["query_key"] },
      { namespace: "secrets", path: ["header_token"] },
      { namespace: "inputs", path: ["location"] },
    ]);
  });
});
