import { expect, test } from "bun:test";
import { detectPythonFormatter, formatPythonFile } from "../../src/format/python";
import type { FormatDeps } from "../../src/format/types";

function deps(over: Partial<FormatDeps>): FormatDeps {
  return {
    which: () => null,
    fileExists: async () => false,
    readFile: async () => "",
    spawn: async () => ({ exitCode: 0 }),
    ...over,
  };
}

test("detect prefers ruff on PATH", async () => {
  const d = await detectPythonFormatter(
    "/p",
    deps({ which: (b) => (b === "ruff" ? "/usr/bin/ruff" : null) }),
  );
  expect(d).toEqual({ tool: "ruff", command: "/usr/bin/ruff", args: ["format"] });
});

test("detect falls back to black when only black is present", async () => {
  const d = await detectPythonFormatter(
    "/p",
    deps({ which: (b) => (b === "black" ? "/usr/bin/black" : null) }),
  );
  expect(d).toEqual({ tool: "black", command: "/usr/bin/black", args: [] });
});

test("detect prefers project .venv/bin over PATH", async () => {
  const d = await detectPythonFormatter(
    "/p",
    deps({
      fileExists: async (p) => p === "/p/.venv/bin/ruff",
      which: () => "/usr/bin/ruff",
    }),
  );
  expect(d).toEqual({ tool: "ruff", command: "/p/.venv/bin/ruff", args: ["format"] });
});

test("detect returns null when neither tool is present", async () => {
  expect(await detectPythonFormatter("/p", deps({}))).toBeNull();
});

test("formatPythonFile reports changed when bytes differ", async () => {
  let n = 0;
  const r = await formatPythonFile(
    "/p/a.py",
    { tool: "ruff", command: "ruff", args: ["format"] },
    "/p",
    deps({
      readFile: async () => (n++ === 0 ? "before" : "after"),
      spawn: async () => ({ exitCode: 0 }),
    }),
    new AbortController().signal,
  );
  expect(r).toEqual({ changed: true, tool: "ruff" });
});

test("formatPythonFile reports unchanged when bytes are identical", async () => {
  const r = await formatPythonFile(
    "/p/a.py",
    { tool: "black", command: "black", args: [] },
    "/p",
    deps({ readFile: async () => "same" }),
    new AbortController().signal,
  );
  expect(r).toEqual({ changed: false, tool: "black" });
});

test("formatPythonFile reports unchanged on non-zero exit (unparseable) and never throws", async () => {
  const r = await formatPythonFile(
    "/p/a.py",
    { tool: "ruff", command: "ruff", args: ["format"] },
    "/p",
    deps({ readFile: async () => "x", spawn: async () => ({ exitCode: 2 }) }),
    new AbortController().signal,
  );
  expect(r).toEqual({ changed: false, tool: "ruff" });
});
