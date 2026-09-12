import { describe, expect, it } from "bun:test";
import { buildDiagnosticsManager } from "../../src/diagnostics/index";

const base = { enabled: true, timeoutMs: 15000, maxReported: 10 } as const;

describe("buildDiagnosticsManager", () => {
  it("returns no manager when disabled", async () => {
    const r = await buildDiagnosticsManager(
      { ...base, enabled: false },
      "/nonexistent-project-dir-xyz",
    );
    expect(r.manager).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it("returns no manager when the project has no recognized markers", async () => {
    const r = await buildDiagnosticsManager(base, "/nonexistent-project-dir-xyz");
    expect(r.manager).toBeUndefined();
  });
});
