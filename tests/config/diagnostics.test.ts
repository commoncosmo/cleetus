import { describe, expect, it } from "bun:test";
import { resolveDiagnostics } from "../../src/config/diagnostics";

describe("resolveDiagnostics", () => {
  it("defaults to enabled, 15s timeout, 10 reported, no language filter", () => {
    expect(resolveDiagnostics(undefined, undefined)).toEqual({
      enabled: true,
      languages: undefined,
      timeoutMs: 15000,
      maxReported: 10,
    });
  });

  it("project overrides global", () => {
    const r = resolveDiagnostics(
      { enabled: true, timeout_ms: 5000 },
      { enabled: false, max_reported: 3, languages: ["typescript"] },
    );
    expect(r.enabled).toBe(false);
    expect(r.maxReported).toBe(3);
    expect(r.timeoutMs).toBe(5000); // inherited from global
    expect(r.languages).toEqual(["typescript"]);
  });
});
