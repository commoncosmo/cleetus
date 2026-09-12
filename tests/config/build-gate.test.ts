import { describe, expect, it } from "bun:test";
import { DEFAULT_BUILD_GATE, resolveBuildGate } from "../../src/config/build-gate";

describe("resolveBuildGate", () => {
  it("defaults all fields when nothing is set", () => {
    expect(resolveBuildGate(undefined, undefined)).toEqual({
      enabled: true,
      maxAttempts: 2,
      timeoutMs: 180000,
      maxOutputLines: 80,
    });
  });

  it("exposes the same values as DEFAULT_BUILD_GATE", () => {
    expect(resolveBuildGate(undefined, undefined)).toEqual(DEFAULT_BUILD_GATE);
  });

  it("lets project override global per field", () => {
    expect(
      resolveBuildGate({ enabled: true, max_attempts: 1 }, { enabled: false, timeout_ms: 5000 }),
    ).toEqual({ enabled: false, maxAttempts: 1, timeoutMs: 5000, maxOutputLines: 80 });
  });

  it("falls back to global when project omits a field", () => {
    expect(resolveBuildGate({ max_attempts: 4 }, {}).maxAttempts).toBe(4);
  });

  it("allows max_attempts of 0 (no corrective rounds)", () => {
    expect(resolveBuildGate({ max_attempts: 0 }, undefined).maxAttempts).toBe(0);
  });
});
