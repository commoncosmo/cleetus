import { describe, expect, it } from "bun:test";
import { parseGoVet } from "../../../src/diagnostics/providers/go";

describe("parseGoVet", () => {
  it("parses file:line:col messages and skips package headers", () => {
    const out = [
      "# example/pkg",
      "./main.go:12:5: undefined: fmt.Printlnx",
      "./util.go:3:1: missing return at end of function",
    ].join("\n");
    const diags = parseGoVet(out, "/home/proj");
    expect(diags).toHaveLength(2);
    expect(diags[0]).toEqual({
      file: "main.go",
      line: 12,
      col: 5,
      severity: "error",
      message: "undefined: fmt.Printlnx",
    });
    expect(diags[1]!.file).toBe("util.go");
  });

  it("returns [] when there is no diagnostic output", () => {
    expect(parseGoVet("", "/home/proj")).toEqual([]);
  });
});
