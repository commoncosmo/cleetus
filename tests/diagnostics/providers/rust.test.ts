import { describe, expect, it } from "bun:test";
import { parseCargoCheck } from "../../../src/diagnostics/providers/rust";

describe("parseCargoCheck", () => {
  it("parses compiler-message lines using the primary span", () => {
    const lines = [
      JSON.stringify({ reason: "compiler-artifact", target: { name: "x" } }),
      JSON.stringify({
        reason: "compiler-message",
        message: {
          level: "error",
          message: "cannot find function `foo` in this scope",
          code: { code: "E0425" },
          spans: [
            { file_name: "src/other.rs", line_start: 1, column_start: 1, is_primary: false },
            { file_name: "src/main.rs", line_start: 4, column_start: 5, is_primary: true },
          ],
        },
      }),
      JSON.stringify({ reason: "build-finished", success: false }),
    ].join("\n");
    const diags = parseCargoCheck(lines, "/home/proj");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toEqual({
      file: "src/main.rs",
      line: 4,
      col: 5,
      severity: "error",
      code: "E0425",
      message: "cannot find function `foo` in this scope",
    });
  });

  it("skips messages with no spans and tolerates malformed lines", () => {
    const lines = [
      "not json",
      JSON.stringify({
        reason: "compiler-message",
        message: { level: "warning", message: "x", spans: [] },
      }),
    ].join("\n");
    expect(parseCargoCheck(lines, "/home/proj")).toEqual([]);
  });
});
