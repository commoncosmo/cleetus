import { describe, expect, it } from "bun:test";
import { diagnosticsRows } from "../../../src/ui/tui/diagnostics-rows";

describe("diagnosticsRows", () => {
  it("splits into one row per line", () => {
    expect(diagnosticsRows("a\nb\nc").map((r) => r.text)).toEqual(["a", "b", "c"]);
  });

  it("flags lines containing the warning glyph", () => {
    const rows = diagnosticsRows("⚠ 1 new diagnostics (tsc)\n  a.ts:1  TS2304  oops");
    expect(rows[0]).toEqual({ text: "⚠ 1 new diagnostics (tsc)", warn: true });
    expect(rows[1]!.warn).toBe(false);
  });

  it("returns a single non-warn row for a clean summary", () => {
    expect(diagnosticsRows("✓ tsc: no new diagnostics")).toEqual([
      { text: "✓ tsc: no new diagnostics", warn: false },
    ]);
  });
});
