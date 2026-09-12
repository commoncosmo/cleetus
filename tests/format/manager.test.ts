import { expect, test } from "bun:test";
import { buildFormatter, formatNotice } from "../../src/format/manager";
import type { FormatDeps } from "../../src/format/types";

function deps(over: Partial<FormatDeps>): FormatDeps {
  return {
    which: (b) => (b === "ruff" ? "/usr/bin/ruff" : null),
    fileExists: async () => false,
    readFile: async () => "",
    spawn: async () => ({ exitCode: 0 }),
    ...over,
  };
}

test("buildFormatter is a no-op when disabled", async () => {
  const f = await buildFormatter({ enabled: false }, { projectDir: "/p", deps: deps({}) });
  expect(await f.formatFiles(["a.py"], new AbortController().signal)).toEqual([]);
});

test("buildFormatter is a no-op when no formatter is detected", async () => {
  const f = await buildFormatter(
    { enabled: true },
    { projectDir: "/p", deps: deps({ which: () => null }) },
  );
  expect(await f.formatFiles(["a.py"], new AbortController().signal)).toEqual([]);
});

test("formatFiles formats .py files, ignores others, returns only changed", async () => {
  let n = 0;
  const f = await buildFormatter(
    { enabled: true },
    {
      projectDir: "/p",
      deps: deps({ readFile: async () => (n++ % 2 === 0 ? "a" : "b") }), // every file changes
    },
  );
  const out = await f.formatFiles(["a.py", "readme.md", "b.py"], new AbortController().signal);
  expect(out.map((r) => r.path)).toEqual(["a.py", "b.py"]); // .md skipped
  expect(out.every((r) => r.changed && r.tool === "ruff")).toBe(true);
});

test("formatFiles reports a project-relative path even for an absolute editedPath", async () => {
  // editedPaths are absolute in production; the notice must read `main.py`, not the full path.
  let n = 0;
  const f = await buildFormatter(
    { enabled: true },
    { projectDir: "/proj", deps: deps({ readFile: async () => String(n++) }) }, // before≠after → changed
  );
  const out = await f.formatFiles(["/proj/src/main.py"], new AbortController().signal);
  expect(out.map((r) => r.path)).toEqual(["src/main.py"]);
});

test("formatNotice renders one terse line per changed file", () => {
  const text = formatNotice([
    { path: "main.py", changed: true, tool: "ruff" },
    { path: "app.py", changed: true, tool: "ruff" },
  ]);
  expect(text).toBe("↻ formatted main.py (ruff)\n↻ formatted app.py (ruff)");
});

test("formatNotice is empty for no results", () => {
  expect(formatNotice([])).toBe("");
});
