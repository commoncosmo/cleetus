import { describe, expect, it } from "bun:test";
import { formatReport } from "../../src/diagnostics/format";
import type { Diagnostic } from "../../src/diagnostics/types";

const diag = (over: Partial<Diagnostic>): Diagnostic => ({
  file: "src/a.ts",
  line: 42,
  severity: "error",
  code: "TS2304",
  message: "Cannot find name 'foo'",
  ...over,
});

describe("formatReport", () => {
  it("clean run reports no new diagnostics", () => {
    const text = formatReport({
      providerId: "tsc",
      status: "ok",
      newDiagnostics: [],
      fixedCount: 0,
      maxReported: 10,
      timeoutMs: 15000,
    });
    expect(text).toBe("✓ tsc: no new diagnostics");
  });

  it("lists new diagnostics with a header", () => {
    const text = formatReport({
      providerId: "tsc",
      status: "ok",
      newDiagnostics: [
        diag({}),
        diag({ line: 51, code: "TS2554", message: "Expected 1 argument" }),
      ],
      fixedCount: 0,
      maxReported: 10,
      timeoutMs: 15000,
    });
    expect(text).toContain("⚠ 2 new diagnostics (tsc)");
    expect(text).toContain("src/a.ts:42");
    expect(text).toContain("TS2304");
    expect(text).toContain("Cannot find name 'foo'");
  });

  it("caps the list at maxReported and notes the overflow", () => {
    const many = Array.from({ length: 13 }, (_, i) => diag({ line: i + 1 }));
    const text = formatReport({
      providerId: "tsc",
      status: "ok",
      newDiagnostics: many,
      fixedCount: 0,
      maxReported: 10,
      timeoutMs: 15000,
    });
    expect(text).toContain("…and 3 more");
    expect(text.split("\n").filter((l) => l.includes("src/a.ts")).length).toBe(10);
  });

  it("mentions fixed count when > 0", () => {
    const text = formatReport({
      providerId: "tsc",
      status: "ok",
      newDiagnostics: [diag({})],
      fixedCount: 2,
      maxReported: 10,
      timeoutMs: 15000,
    });
    expect(text).toContain("also fixed 2 pre-existing");
  });

  it("renders a single muted line on timeout", () => {
    const text = formatReport({
      providerId: "cargo-check",
      status: "timeout",
      newDiagnostics: [],
      fixedCount: 0,
      maxReported: 10,
      timeoutMs: 15000,
    });
    expect(text).toBe("⚠ cargo-check diagnostics timed out (15s) — skipped");
  });

  it("no_baseline: reports all diagnostics with the no-baseline prefix", () => {
    const text = formatReport({
      providerId: "tsc",
      status: "no_baseline",
      newDiagnostics: [
        {
          file: "src/a.ts",
          line: 3,
          severity: "error",
          code: "TS2304",
          message: "Cannot find name 'x'.",
        },
      ],
      fixedCount: 0,
      maxReported: 10,
      timeoutMs: 20000,
    });
    expect(text).toContain(
      "⚠ 1 diagnostics in the edited file(s) (tsc, no baseline — showing all)",
    );
    expect(text).toContain("src/a.ts:3");
  });

  it("no_baseline: clean edited files report success and note the baseline", () => {
    const text = formatReport({
      providerId: "tsc",
      status: "no_baseline",
      newDiagnostics: [],
      fixedCount: 0,
      maxReported: 10,
      timeoutMs: 20000,
    });
    expect(text).toBe("✓ tsc: no diagnostics in the edited file(s)");
  });

  it("renders a muted line when unavailable", () => {
    const text = formatReport({
      providerId: "go-vet",
      status: "unavailable",
      newDiagnostics: [],
      fixedCount: 0,
      maxReported: 10,
      timeoutMs: 15000,
    });
    expect(text).toBe("⚠ go-vet diagnostics unavailable — skipped");
  });
});
