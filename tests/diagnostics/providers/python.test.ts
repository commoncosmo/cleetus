import { describe, expect, it } from "bun:test";
import { parsePyright, parseRuff } from "../../../src/diagnostics/providers/python";

describe("parsePyright", () => {
  it("parses generalDiagnostics, converting 0-based line to 1-based", () => {
    const json = JSON.stringify({
      generalDiagnostics: [
        {
          file: "/home/proj/app.py",
          severity: "error",
          rule: "reportAttributeAccessIssue",
          message: 'Cannot access attribute "foo"',
          range: { start: { line: 11, character: 4 } },
        },
      ],
    });
    const diags = parsePyright(json, "/home/proj");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toEqual({
      file: "app.py",
      line: 12,
      col: 5,
      severity: "error",
      code: "reportAttributeAccessIssue",
      message: 'Cannot access attribute "foo"',
    });
  });

  it("maps non-error severities to warning and tolerates bad JSON", () => {
    const json = JSON.stringify({
      generalDiagnostics: [
        {
          file: "/home/proj/a.py",
          severity: "warning",
          message: "unused",
          range: { start: { line: 0, character: 0 } },
        },
      ],
    });
    expect(parsePyright(json, "/home/proj")[0]!.severity).toBe("warning");
    expect(parsePyright("not json", "/home/proj")).toEqual([]);
  });
});

describe("parseRuff", () => {
  it("parses ruff JSON, converting columns and mapping to warning", () => {
    const json = JSON.stringify([
      {
        filename: "/home/proj/app.py",
        code: "F821",
        message: "Undefined name `foo`",
        location: { row: 12, column: 5 },
      },
    ]);
    const diags = parseRuff(json, "/home/proj");
    expect(diags[0]).toEqual({
      file: "app.py",
      line: 12,
      col: 5,
      severity: "warning",
      code: "F821",
      message: "Undefined name `foo`",
    });
  });

  it("returns [] for non-array or invalid JSON", () => {
    expect(parseRuff("{}", "/home/proj")).toEqual([]);
    expect(parseRuff("oops", "/home/proj")).toEqual([]);
  });
});
