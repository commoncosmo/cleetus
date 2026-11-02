import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCollect } from "../../../src/sandbox/spawn";
import type { Sandbox } from "../../../src/sandbox/types";
import { RenderCheckTool } from "../../../src/tools/render-check";
import {
  windowsRenderArgv,
  windowsRenderScript,
  windowsShimScript,
} from "../../../src/tools/render-check/windows";

test("render argv preserves the package manager, quoted spaces, empty values and literal expressions", () => {
  expect(
    windowsRenderArgv(`npm run dev -- --label "O'Hara app" --empty '' --literal '$env:NAME'`),
  ).toEqual([
    "npm",
    "run",
    "dev",
    "--",
    "--label",
    "O'Hara app",
    "--empty",
    "",
    "--literal",
    "$env:NAME",
  ]);
  expect(windowsRenderArgv("pnpm dev --host 127.0.0.1")).toEqual([
    "pnpm",
    "dev",
    "--host",
    "127.0.0.1",
  ]);
  expect(() => windowsRenderArgv('npm run dev -- "unfinished')).toThrow("unterminated");
});

test("render supervisor does not reference or spawn the selected agent PowerShell", () => {
  const script = windowsRenderScript({
    launchCommand: "npm run dev",
    url: "http://localhost:5173",
    budgetMs: 1000,
  });
  expect(script).not.toContain("pwsh.exe");
  expect(script).not.toContain("WindowsApps");
  expect(script).toContain("WindowsPowerShell");
  // The generated function is self-contained, including when bundled/compiled.
  expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(script)).not.toThrow();
});

test.skipIf(process.platform !== "win32" || !Bun.which("bun.exe"))(
  "Windows verification uses direct execution without asking for a nested agent shell",
  async () => {
    let executions = 0;
    const sandbox: Sandbox = {
      shell: "powershell",
      shellExecutable: async () => {
        throw new Error("nested Store activation must not be attempted");
      },
      exec: async () => {
        throw new Error("must use execArgv");
      },
      execArgv: async (argv, options) => {
        executions++;
        expect(argv.slice(1)).toEqual(["run", "-"]);
        expect(options.stdin).not.toContain("pwsh.exe");
        return {
          stdout: `CLEETUS_CONTROL_PROBE:${JSON.stringify({
            observed: true,
            expectedTextPresent: true,
            bodyText: "Ready",
            controlFound: false,
            controlVisible: false,
            controlEnabled: false,
            controlOccluded: false,
          })}`,
          stderr: "",
          exitCode: 0,
          timedOut: false,
          cancelled: false,
        };
      },
      dispose: async () => {},
      writeRoot: () => process.cwd(),
    };
    const result = await new RenderCheckTool(sandbox, { timeoutMs: 1000, maxOutputLines: 10 }).run(
      { launchCommand: "npm run dev", url: "http://localhost:5173", expectedText: "Ready" },
      { projectDir: process.cwd(), abortSignal: new AbortController().signal },
    );
    expect(executions).toBe(1);
    expect(result.ok).toBe(true);
  },
);

test.skipIf(process.platform !== "win32")(
  "inbox shim launcher handles paths with spaces and apostrophes and retains failure status",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus shim's "));
    try {
      const shim = join(root, "test shim.cmd");
      writeFileSync(shim, "@echo off\r\necho %~1\r\nexit /b 7\r\n");
      const script = windowsShimScript([shim, "O'Hara app"]);
      const result = await spawnCollect(
        [
          join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { signal: new AbortController().signal, timeoutMs: 5000 },
      );
      expect(result.stdout.trim()).toBe("O'Hara app");
      expect(result.exitCode).toBe(7);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
