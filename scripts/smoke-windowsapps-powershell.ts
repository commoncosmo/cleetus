import { strict as assert } from "node:assert";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WindowsSandbox } from "../src/sandbox/windows";
import { findPowerShell, resolvePowerShell } from "../src/sandbox/powershell";
import { spawnCollect } from "../src/sandbox/spawn";
import { checkWindowsPrerequisites, environmentExitCode } from "../src/setup/windows-environment";
import { checkWindowsEnforcement } from "../src/setup/windows-enforcement";

const alias = process.argv[2] ?? join(process.env.LOCALAPPDATA!, "Microsoft/WindowsApps/pwsh.exe");
assert.ok(existsSync((await resolvePowerShell(alias))!), `WindowsApps PowerShell is missing: ${alias}`);
const opts = () => ({ signal: new AbortController().signal, timeoutMs: 15000 });
const identified = await spawnCollect([alias,"-NoProfile","-NonInteractive","-Command","[Environment]::ProcessPath"],opts());
assert.equal(identified.exitCode,0);
const packaged = identified.stdout.trim();
assert.match(packaged,/WindowsApps.*Microsoft.PowerShell/i);
assert.equal(findPowerShell(Bun.which,{PATH:dirname(alias)}),packaged);
const executor = resolve(`dist/cleetus-windows-${process.arch}/native/wxc-exec.exe`);
const project = resolve("dist/windowsapps-smoke",String(Date.now()));
mkdirSync(project,{recursive:true});
for(const shell of [alias,packaged]) {
  const sandbox = new WindowsSandbox(project,true,executor,shell);
  try {
    // Production resolver, encoded wrapper, and actual native capability probe.
    assert.equal(await sandbox.shellExecutable(),packaged);
    assert.equal(await sandbox.healthCheck(),null);
    const result=await sandbox.exec("Get-Location; Write-Host HOST_MESSAGE; Write-Output FORMATTING_OK",opts());
    assert.equal(result.exitCode,0,result.stderr);
    assert.ok(result.stdout.includes(project));
    assert.match(result.stdout,/HOST_MESSAGE/); assert.match(result.stdout,/FORMATTING_OK/);
    const flags=await sandbox.exec("Get-ChildItem -la",opts());
    assert.notEqual(flags.exitCode,0); assert.match(flags.stderr,/parameter.*la/i);
    assert.doesNotMatch(flags.stderr,/MSIX|doctor/);
    const report=await checkWindowsPrerequisites(project,"host",{executor,which:name=>name==="pwsh.exe"?shell:Bun.which(name)});
    assert.equal(environmentExitCode(report),0,JSON.stringify(report));
    assert.equal(report.checks.find(c=>c.id==="mxc-runtime")?.status,"pass");
  } finally { await sandbox.dispose(); }
}
const enforcement=await checkWindowsEnforcement(executor,packaged);
assert.ok(!enforcement.some(c=>c.requirement==="required"&&c.status==="fail"),JSON.stringify(enforcement));
// Each smoke test uses an isolated project and this shell without changing PATH.
for(const script of ["scripts/smoke-windows.ts","scripts/smoke-windows-render.ts"]) {
  const child=Bun.spawn([process.execPath,"run",script,alias],{stdout:"inherit",stderr:"inherit"});
  assert.equal(await child.exited,0,`${script} failed`);
}
console.log(`WINDOWSAPPS_POWERSHELL_PASS ${packaged}`);
