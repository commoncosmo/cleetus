import { describe, expect, it } from "bun:test";
import { TypeScriptProvider, parseTsc } from "../../../src/diagnostics/providers/typescript";
import { toRelative } from "../../../src/diagnostics/relpath";
import type { DiagnosticExec } from "../../../src/diagnostics/types";

describe("toRelative", () => {
  it("strips the projectDir prefix from an absolute path", () => {
    expect(toRelative("/home/proj", "/home/proj/src/a.ts")).toBe("src/a.ts");
  });
  it("strips a leading ./ from a relative path", () => {
    expect(toRelative("/home/proj", "./src/a.ts")).toBe("src/a.ts");
  });
  it("leaves an unrelated path unchanged", () => {
    expect(toRelative("/home/proj", "/other/x.ts")).toBe("/other/x.ts");
  });
});

describe("parseTsc", () => {
  it("parses error lines with code, line, col", () => {
    const out = [
      "src/api.ts(42,10): error TS2304: Cannot find name 'fetchUserz'.",
      "src/api.ts(51,3): error TS2554: Expected 1 arguments, but got 2.",
    ].join("\n");
    const diags = parseTsc(out, "/home/proj");
    expect(diags).toHaveLength(2);
    expect(diags[0]).toEqual({
      file: "src/api.ts",
      line: 42,
      col: 10,
      severity: "error",
      code: "TS2304",
      message: "Cannot find name 'fetchUserz'.",
    });
    expect(diags[1]!.code).toBe("TS2554");
  });

  it("ignores non-diagnostic noise and blank lines", () => {
    const out = "\nFound 0 errors.\n";
    expect(parseTsc(out, "/home/proj")).toEqual([]);
  });
});

describe("TypeScriptProvider.run", () => {
  it("uses an injected executor so ACP can route diagnostics through its active sandbox", async () => {
    const calls: { argv: string[]; cwd: string }[] = [];
    const exec: DiagnosticExec = async (argv, opts) => {
      calls.push({ argv, cwd: opts.cwd });
      return {
        stdout: "src/app.ts(3,4): error TS2304: Cannot find name 'missing'.\n",
        stderr: "",
        exitCode: 2,
        timedOut: false,
        cancelled: false,
      };
    };

    const result = await new TypeScriptProvider().run(
      { command: "/tools/tsc", baseArgs: [] },
      "/project",
      new AbortController().signal,
      5000,
      exec,
    );

    expect(calls).toEqual([
      {
        argv: ["/tools/tsc", "--noEmit", "--pretty", "false"],
        cwd: "/project",
      },
    ]);
    expect(result.diagnostics[0]).toMatchObject({ file: "src/app.ts", code: "TS2304" });
  });
});
