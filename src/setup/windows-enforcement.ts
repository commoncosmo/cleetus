import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { WindowsSandbox } from "../sandbox/windows";
import type { EnvironmentCheck } from "./windows-environment";

const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** All writes and destructive probes target a fresh, disposable synthetic workspace. */
export async function checkWindowsEnforcement(
  executor: string,
  powershell: string,
): Promise<EnvironmentCheck[]> {
  // The normal sandbox deliberately permits the host temp directory. Put the
  // fixture under home so its sibling outside.txt really is outside all write grants.
  const root = await mkdtemp(join(homedir(), ".cleetus-doctor-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const outside = join(root, "outside.txt");
  const secret = join(home, ".ssh/synthetic-secret");
  const checks: EnvironmentCheck[] = [];
  let pids: number[] = [];
  const sandbox = new WindowsSandbox(project, false, executor, powershell, home);
  const signal = new AbortController().signal;
  const run = (command: string, protectProjectMetadata = false) =>
    sandbox.exec(command, { signal, timeoutMs: 8000, protectProjectMetadata });
  const check = async (
    id: string,
    label: string,
    test: () => Promise<void>,
    requirement: EnvironmentCheck["requirement"] = "required",
  ) => {
    try {
      await test();
      checks.push({
        id,
        label,
        requirement,
        status: "pass",
        detail: "Verified in a disposable workspace.",
      });
    } catch {
      checks.push({
        id,
        label,
        requirement,
        status: requirement === "required" ? "fail" : "warn",
        detail: "The synthetic enforcement check failed.",
        remedy: id.startsWith("bun")
          ? "The installed Bun workload did not pass inside MXC. Use scaffold's bounded npm recovery for a fresh Vite project; keep Bun-managed projects on Bun and resolve their runtime compatibility. Do not use .cleetus for caches."
          : "Keep host sandboxing enabled; verify Windows updates and application-control policy before running agent commands.",
      });
    }
  };
  try {
    for (const p of [project, join(project, ".git"), join(project, ".cleetus"), join(home, ".ssh")])
      await mkdir(p, { recursive: true });
    await writeFile(outside, "unchanged");
    await writeFile(secret, "synthetic secret");
    await check("shell-failures", "PowerShell command failures remain readable", async () => {
      const exit = await run("Write-Output 'CLEETUS_EXIT_PROBE'; exit 7");
      assert.equal(exit.exitCode, 7);
      assert.match(exit.stdout, /CLEETUS_EXIT_PROBE/);
      const error = await run("throw 'CLEETUS_EXPECTED_ERROR'");
      assert.notEqual(error.exitCode, 0);
      assert.match(error.stderr, /CLEETUS_EXPECTED_ERROR/);
      const syntax = await run("if (");
      assert.notEqual(syntax.exitCode, 0);
      assert.ok(!syntax.stderr.includes("#< CLIXML"));
      assert.ok(!`${exit.stderr}${error.stderr}`.includes("Uninstall the packaged version"));
    });
    const bun = Bun.which("bun.exe");
    if (bun) {
      await check(
        "bun-temp-cache",
        "Bun temp and cache writes",
        async () => {
          const script = `const fs=require('node:fs'),os=require('node:os'),p=require('node:path'); for(const base of [os.tmpdir(),process.env.BUN_TMPDIR,process.env.BUN_INSTALL_CACHE_DIR]) {if(!base)throw Error('missing temp/cache'); const dir=fs.mkdtempSync(p.join(base,'doctor-')); const file=p.join(dir,'probe'); fs.writeFileSync(file,'ok');if(fs.readFileSync(file,'utf8')!=='ok')throw Error('readback'); fs.rmSync(dir,{recursive:true});} console.log('BUN_IO_PASS');`;
          const result = await run(`& ${literal(bun)} -e ${literal(script)}`);
          assert.equal(result.exitCode, 0);
          assert.match(result.stdout, /BUN_IO_PASS/);
        },
        "project",
      );
      await check(
        "bunx-local",
        "Bun package runner (offline local fixture)",
        async () => {
          await mkdir(join(project, "node_modules/.bin"), { recursive: true });
          await writeFile(
            join(project, "node_modules/.bin/cleetus-doctor.cmd"),
            "@echo off\r\necho BUNX_LOCAL_PASS\r\n",
          );
          const result = await run(`& ${literal(bun)} x --no-install cleetus-doctor`);
          assert.equal(result.exitCode, 0);
          assert.match(result.stdout, /BUNX_LOCAL_PASS/);
          const bunx = Bun.which("bunx.exe");
          if (bunx) {
            const alias = await run(`& ${literal(bunx)} --no-install cleetus-doctor`);
            assert.equal(alias.exitCode, 0);
            assert.match(alias.stdout, /BUNX_LOCAL_PASS/);
          }
          const missing = await run(
            `& ${literal(bun)} x --no-install cleetus-doctor-missing-${crypto.randomUUID()}`,
          );
          assert.notEqual(missing.exitCode, 0);
          assert.ok(
            !/EBADF|EPERM.*temporary directory|set \$BUN_TMPDIR/i.test(
              `${missing.stdout}\n${missing.stderr}`,
            ),
          );
        },
        "project",
      );
    } else
      checks.push({
        id: "bun-temp-cache",
        label: "Bun temp and cache writes",
        requirement: "project",
        status: "skip",
        detail: "Bun is not installed on PATH; no project Bun workload was tested.",
      });
    await check("filesystem", "Allowed writes and denied outside writes", async () => {
      const file = join(project, "allowed.txt");
      const r = await run(
        `[IO.File]::WriteAllText(${literal(file)}, 'allowed'); try { [IO.File]::WriteAllText(${literal(outside)}, 'escaped'); throw 'write restriction bypassed' } catch [System.UnauthorizedAccessException] { }`,
      );
      assert.equal(r.exitCode, 0);
      assert.equal(await readFile(file, "utf8"), "allowed");
      assert.equal(await readFile(outside, "utf8"), "unchanged");
    });
    await check("secret-read", "Denied secret reads", async () => {
      const r = await run(
        `try { [IO.File]::ReadAllText(${literal(secret)}); throw 'read restriction bypassed' } catch [System.UnauthorizedAccessException] { }`,
      );
      assert.equal(r.exitCode, 0);
    });
    await check("metadata", "Project metadata read-only", async () => {
      for (const name of [".git", ".cleetus"]) {
        const path = join(project, name, "sentinel");
        await writeFile(path, "unchanged");
        const r = await run(
          `if ([IO.File]::ReadAllText(${literal(path)}) -ne 'unchanged') { throw 'metadata unreadable' }; try { [IO.File]::WriteAllText(${literal(path)}, 'escaped'); throw 'metadata restriction bypassed' } catch [System.UnauthorizedAccessException] { }`,
          true,
        );
        assert.equal(r.exitCode, 0);
        assert.equal(await readFile(path, "utf8"), "unchanged");
      }
    });
    await check("cancellation", "Cancellation reaps descendants", async () => {
      const worker = `$depth=[int]$env:CLEETUS_DOCTOR_DEPTH;
[IO.File]::WriteAllText([IO.Path]::Combine($env:CLEETUS_DOCTOR_PROJECT, "$depth.pid"),[string]$PID);
if ($depth -lt 2) {
  $start=[Diagnostics.ProcessStartInfo]::new();
  $start.FileName=$env:CLEETUS_DOCTOR_PWSH;
  $start.Arguments='-NoLogo -NoProfile -NonInteractive -EncodedCommand '+$env:CLEETUS_DOCTOR_WORKER;
  $start.UseShellExecute=$false; $start.CreateNoWindow=$true;
  $start.Environment['CLEETUS_DOCTOR_DEPTH']=[string]($depth+1);
  $child=[Diagnostics.Process]::Start($start);
}
Start-Sleep 30`;
      const controller = new AbortController();
      const pending = sandbox.exec(worker, {
        signal: controller.signal,
        timeoutMs: 15000,
        env: {
          CLEETUS_DOCTOR_WORKER: Buffer.from(worker, "utf16le").toString("base64"),
          CLEETUS_DOCTOR_DEPTH: "0",
          CLEETUS_DOCTOR_PROJECT: project,
          CLEETUS_DOCTOR_PWSH: powershell,
        },
      });
      void pending.catch(() => {});
      try {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          try {
            pids = await Promise.all(
              ["0", "1", "2"].map(async (name) =>
                Number(await readFile(join(project, `${name}.pid`), "utf8")),
              ),
            );
            if (pids.every((pid) => pid > 0 && alive(pid))) break;
          } catch {
            /* descendants are not ready */
          }
          await Bun.sleep(100);
        }
        assert.equal(pids.length, 3);
        assert.ok(pids.every((pid) => pid > 0 && alive(pid)));
        controller.abort();
        const result = await pending;
        assert.equal(result.cancelled, true);
        const reaped = Date.now() + 5000;
        while (pids.some(alive) && Date.now() < reaped) await Bun.sleep(100);
        assert.deepEqual(pids.filter(alive), []);
      } finally {
        controller.abort();
        await pending.catch(() => {});
      }
    });
  } finally {
    await sandbox.dispose();
    if (
      resolve(dirname(root)) === resolve(homedir()) &&
      basename(root).startsWith(".cleetus-doctor-") &&
      !pids.some(alive)
    ) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        checks.push({
          id: "cleanup",
          label: "Diagnostic cleanup",
          requirement: "required",
          status: "fail",
          detail: `Could not remove diagnostic workspace ${root}; it may be locked.`,
        });
      }
    } else
      checks.push({
        id: "cleanup",
        label: "Diagnostic cleanup",
        requirement: "required",
        status: "fail",
        detail: `Temporary diagnostics retained at ${root}; a process may still be alive.`,
      });
  }
  return checks;
}
