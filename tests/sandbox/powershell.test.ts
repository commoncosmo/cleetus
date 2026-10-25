import { expect, test } from "bun:test";
import { looksLikeExecutionDenial, looksLikeWriteDenial } from "../../src/sandbox/boundary";
import { resolvePowerShell } from "../../src/sandbox/powershell";
import { normalizeWindowsResult, plainPowerShellOutput } from "../../src/sandbox/powershell-output";
import { powershellArgs } from "../../src/sandbox/shell";
import { spawnCollect } from "../../src/sandbox/spawn";
import { powershellHint } from "../../src/tools/powershell-hint";

test("fails early for both WindowsApps aliases and real packaged executables", async () => {
  for (const path of [
    "C:/Users/sam/AppData/Local/Microsoft/WindowsApps/Microsoft.PowerShell_8wekyb3d8bbwe/pwsh.exe",
    "C:/Program Files/WindowsApps/Microsoft.PowerShell_7.6.8.0_arm64__8wekyb3d8bbwe/pwsh.exe",
  ])
    await expect(resolvePowerShell(path)).rejects.toThrow("unpackaged PowerShell");
  expect(await resolvePowerShell("C:/Program Files/PowerShell/7/pwsh.exe")).toBe(
    "C:/Program Files/PowerShell/7/pwsh.exe",
  );
});

test.skipIf(process.platform !== "win32" || !Bun.which("pwsh.exe"))(
  "flushes mixed PowerShell objects, strings, and errors before exiting",
  async () => {
    const run = (script: string) =>
      spawnCollect([Bun.which("pwsh.exe")!, ...powershellArgs(script)], {
        signal: new AbortController().signal,
        timeoutMs: 10000,
      });
    const listing = await run(
      "Get-Location; Get-ChildItem -LiteralPath . -Force | Select-Object -First 1; Write-Output END_OF_LIST",
    );
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout).toContain(process.cwd());
    expect(listing.stdout).toContain("END_OF_LIST");
    const info = await run(
      "Write-Host HELLO; Write-Progress -Activity Test -Status Run; Write-Output DONE",
    );
    expect(info.stdout).toContain("HELLO");
    expect(info.stdout).toContain("DONE");
    expect(info.stderr).toBe("");
    const failed = await run(
      "Write-Output BEFORE_ERROR; Get-Item -LiteralPath no-such-ct4-file; Write-Output MUST_NOT_RUN",
    );
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout).toContain("BEFORE_ERROR");
    expect(failed.stdout).not.toContain("MUST_NOT_RUN");
  },
);

test("drops CLIXML progress/information metadata while retaining real errors", () => {
  const xml =
    '#< CLIXML\n<Objs><Obj S="progress"><MS><S N="Activity">noise</S></MS></Obj><Obj S="information"><MS><S N="Message">HELLO</S><S N="Computer">HOST</S></MS></Obj><S S="Error">Invalid flag_x000D__x000A_</S></Objs>';
  expect(plainPowerShellOutput(xml)).toBe("Invalid flag\r\n");
});

test.skipIf(process.platform !== "win32" || !Bun.which("pwsh.exe"))(
  "drains failing native pipelines and retains failure after successful logging",
  async () => {
    const run = (script: string) =>
      spawnCollect([Bun.which("pwsh.exe")!, ...powershellArgs(script)], {
        signal: new AbortController().signal,
        timeoutMs: 10000,
      });
    const result = await run(
      `node -e "console.log('CT7_COMPILER_ERROR');process.exit(2)" | Select-Object -Last 10; Write-Output LOGGED; node -e "process.exit(0)"`,
    );
    expect(result.stdout).toContain("CT7_COMPILER_ERROR");
    expect(result.stdout).toContain("LOGGED");
    expect(result.exitCode).toBe(2);
    const conditional = await run(
      `node -e "console.log('FAILED');process.exit(3)" && Write-Output MUST_NOT_RUN`,
    );
    expect(conditional.exitCode).toBe(3);
    expect(conditional.stdout).not.toContain("MUST_NOT_RUN");
  },
);

test("ordinary command errors do not recommend doctor or change exit status", () => {
  const r = normalizeWindowsResult({
    stdout: "",
    stderr:
      "A parameter cannot be found that matches parameter name 'la'.\nThe target executable 'pwsh.exe' appears to be a packaged (MSIX) app.",
    exitCode: 1,
    timedOut: false,
    cancelled: false,
  });
  expect(r.stderr).not.toContain("doctor");
  expect(r.stderr).not.toContain("MSIX");
  expect(r.exitCode).toBe(1);
  expect(powershellHint("ls -la", r.stderr)).toContain("Get-ChildItem -Force");
});

test("execution denial is distinct from a denied filesystem write", () => {
  const error =
    "An error occurred trying to start process 'C:\\node.exe' with working directory 'C:\\app'. Access is denied.";
  expect(looksLikeExecutionDenial(error)).toBe(true);
  expect(looksLikeWriteDenial(error)).toBe(false);
  expect(looksLikeWriteDenial("Access to the path 'C:\\out.log' is denied.")).toBe(true);
  expect(looksLikeWriteDenial("EPERM: operation not permitted, uv_spawn 'pwsh.exe'")).toBe(false);
});
