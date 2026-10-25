import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { WindowsSandbox } from "../src/sandbox/windows";
import { powershellArgs } from "../src/sandbox/shell";
import { spawnCollect } from "../src/sandbox/spawn";
import { checkWindowsPrerequisites, environmentExitCode } from "../src/setup/windows-environment";
import { RenderCheckTool } from "../src/tools/render-check";

const alias = process.argv[2] ?? "C:/Users/samal/AppData/Local/Microsoft/WindowsApps/Microsoft.PowerShell_8wekyb3d8bbwe/pwsh.exe";
assert.ok(existsSync(alias), `WindowsApps PowerShell is missing: ${alias}`);
const opts = () => ({ signal: new AbortController().signal, timeoutMs: 15000 });
const identified = await spawnCollect([alias,"-NoProfile","-NonInteractive","-Command","[Environment]::ProcessPath"],opts());
assert.equal(identified.exitCode,0);
const packaged = identified.stdout.trim();
assert.match(packaged,/WindowsApps.*Microsoft.PowerShell/i);
console.log(`WINDOWSAPPS_INSTALLATION ${packaged}`);

const formatted = await spawnCollect([alias,...powershellArgs("Get-Location; Get-ChildItem -Force | Select-Object -First 1; Write-Host HOST_MESSAGE; Write-Progress -Activity Test -Status Run; Write-Output FORMATTING_OK")],opts());
assert.equal(formatted.exitCode,0); assert.ok(formatted.stdout.includes(process.cwd()));
assert.match(formatted.stdout,/HOST_MESSAGE/); assert.match(formatted.stdout,/FORMATTING_OK/);
assert.equal(formatted.stderr,"");
const flags = await spawnCollect([alias,...powershellArgs("Get-ChildItem -la")],opts());
assert.notEqual(flags.exitCode,0); assert.match(flags.stderr,/parameter.*la/i);

const executor = resolve(`dist/cleetus-windows-${process.arch}/native/wxc-exec.exe`);
const sandbox = new WindowsSandbox(process.cwd(),true,executor,alias);
try {
  // Exercise the raw SDK independently of Cleetus's new early prerequisite check.
  for (const shell of [alias,packaged]) {
    const raw = await sandbox.execArgv([shell,...powershellArgs("Write-Output RAW_PACKAGED_LAUNCH")],opts());
    assert.notEqual(raw.exitCode,0); assert.match(raw.stderr,/packaged|MSIX|CreateProcess/i);
    console.log(`MXC_PACKAGED_ROOT_REJECTED ${shell}`);
  }
  const nested = await sandbox.execArgv([Bun.which("bun.exe")!,"-e",`try { const p=Bun.spawn(${JSON.stringify([packaged,"-NoProfile","-Command","Write-Output NESTED_PACKAGED_LAUNCH"])},{stdout:'pipe',stderr:'pipe'}); await p.exited; process.exit(0); } catch(error) { console.error(error.code); process.exit(69); }`],opts());
  assert.equal(nested.exitCode,69); assert.match(nested.stderr,/EACCES|EPERM/);
  await assert.rejects(sandbox.exec("Write-Output SHOULD_NOT_RUN",opts()),/unpackaged PowerShell/);
  const render = await new RenderCheckTool(sandbox,{timeoutMs:15000,maxOutputLines:10}).run({launchCommand:"npm run dev",url:"http://localhost:5173",expectedText:"ct4"},{projectDir:process.cwd(),abortSignal:new AbortController().signal});
  assert.equal(render.verificationBlocked,true); assert.match(render.errorMessage ?? "",/unpackaged PowerShell/);
  const report = await checkWindowsPrerequisites(process.cwd(),"host",{executor,which:name=>name==="pwsh.exe"?alias:Bun.which(name)});
  assert.equal(environmentExitCode(report),1);
  assert.equal(report.checks.find(check=>check.id==="powershell-packaging")?.status,"fail");
  assert.equal(report.checks.find(check=>check.id==="mxc-runtime")?.status,"skip");
  console.log("WINDOWSAPPS_POWERSHELL_PASS: host formatting, SDK root/nested rejection, fail-fast execution/render, and doctor prerequisite checks");
} finally { await sandbox.dispose(); }
