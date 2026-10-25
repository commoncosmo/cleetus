import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WindowsSandbox } from "../src/sandbox/windows";
import { stageWindowsRuntime } from "./stage-windows";

// Compile the same small worker used by the original packaging proof.
const arch = process.env.CLEETUS_SMOKE_ARCH ?? process.arch;
const root = resolve("dist/windows-smoke", `${arch} ${Date.now()}`);
const project = join(root, "project");
const outside = join(root, "outside");
for (const p of [
  project,
  outside,
  join(project, "secret"),
  join(project, ".git"),
  join(project, ".cleetus"),
])
  mkdirSync(p, { recursive: true });
const exe = join(root, "worker.exe");
const build = Bun.spawnSync(
  [
    process.execPath,
    "build",
    "experiments/mxc/worker-entry.ts",
    "--compile",
    `--target=bun-windows-${arch}`,
    "--outfile",
    exe,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
assert.equal(build.exitCode, 0);
stageWindowsRuntime(exe, arch);
const executor = join(root, "native/wxc-exec.exe");
const home = join(root, "home");
mkdirSync(join(home, ".ssh"), { recursive: true });
const secretFile = join(home, ".ssh/synthetic-secret");
writeFileSync(secretFile, "synthetic secret");
const sandbox = new WindowsSandbox(project, false, executor, Bun.which("pwsh.exe"), home);
const signal = new AbortController().signal;
const run = (command: string, protectProjectMetadata = false) =>
  sandbox.exec(command, { signal, timeoutMs: 15000, protectProjectMetadata });
const health = await sandbox.healthCheck();
assert.equal(health, null);
const specialArgs = [
  "space and 'quote'",
  'double " quote',
  "trailing\\",
  "line\nbreak",
  "$(inert); & | %PATH%",
];
const argvResult = await sandbox.execArgv([exe, "--mxc-worker", "argv", ...specialArgs], {
  signal,
  timeoutMs: 15000,
});
assert.equal(argvResult.exitCode, 0, argvResult.stderr);
assert.deepEqual(JSON.parse(argvResult.stdout), specialArgs);
assert.equal(
  (await run("Write-Output 'native PowerShell works'")).stdout.trim(),
  "native PowerShell works",
);
assert.equal(
  (await sandbox.execArgv(["git", "--version"], { signal, timeoutMs: 15000 })).exitCode,
  0,
);
writeFileSync(join(outside, "sentinel.txt"), "unchanged");
// Shell writes are confined even when Windows paths and spaces occur in the command.
const psPath = (p: string) => `'${p.replaceAll("'", "''")}'`;
const runtimeMarker = join(root, "native/trusted-marker");
writeFileSync(runtimeMarker, "trusted");
assert.notEqual(
  (await run(`[IO.File]::WriteAllText(${psPath(runtimeMarker)}, 'replaced')`)).exitCode,
  0,
);
assert.equal(readFileSync(runtimeMarker, "utf8"), "trusted");
assert.notEqual((await run(`[IO.File]::ReadAllText(${psPath(secretFile)})`)).exitCode, 0);
assert.notEqual(
  (await run("cmd.exe /c exit 7 | Out-Null")).exitCode,
  0,
  "native pipeline failure was masked",
);
const stdin = await sandbox.exec("[Console]::In.ReadToEnd()", {
  signal,
  timeoutMs: 15000,
  stdin: "stdin roundtrip",
});
assert.equal(stdin.stdout.trim(), "stdin roundtrip");
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => {
    requests++;
    return new Response("network works");
  },
});
const online = new WindowsSandbox(project, true, executor, Bun.which("pwsh.exe"), home);
try {
  const command = `Invoke-RestMethod 'http://127.0.0.1:${server.port}/' -TimeoutSec 3`;
  const allowed = await online.exec(command, { signal, timeoutMs: 10000 });
  assert.equal(allowed.exitCode, 0, allowed.stderr);
  assert.equal(requests, 1);
  const denied = await run(command);
  assert.notEqual(denied.exitCode, 0);
  assert.equal(requests, 1, "network-denied command reached the server");
} finally {
  server.stop(true);
  await online.dispose();
}
assert.equal(
  (await run(`[IO.File]::WriteAllText(${psPath(join(project, "allowed.txt"))}, 'allowed')`))
    .exitCode,
  0,
);
assert.notEqual(
  (await run(`[IO.File]::WriteAllText(${psPath(join(outside, "sentinel.txt"))}, 'escaped')`))
    .exitCode,
  0,
);
assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "unchanged");
for (const directory of [".git", ".cleetus"]) {
  const file = join(project, directory, "sentinel");
  writeFileSync(file, "unchanged");
  assert.notEqual(
    (await run(`[IO.File]::WriteAllText(${psPath(file)}, 'escaped')`, true)).exitCode,
    0,
    `${directory} write was allowed`,
  );
  assert.equal(readFileSync(file, "utf8"), "unchanged");
  assert.equal(
    (await run(`[IO.File]::ReadAllText(${psPath(file)})`, true)).stdout.trim(),
    "unchanged",
  );
  assert.equal((await run(`[IO.File]::WriteAllText(${psPath(file)}, 'trusted')`)).exitCode, 0);
}
const controller = new AbortController();
const pending = sandbox.execArgv([exe, "--mxc-worker", "parent", project, outside], {
  signal: controller.signal,
  timeoutMs: 20000,
});
const readyDeadline = Date.now() + 15000;
while (!existsSync(join(project, "grandchild.pid")) && Date.now() < readyDeadline)
  await Bun.sleep(100);
assert.ok(existsSync(join(project, "grandchild.pid")), "grandchild failed to start");
const pids = ["parent", "child", "grandchild"].map((p) =>
  Number(readFileSync(join(project, `${p}.pid`), "utf8")),
);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
assert.ok(pids.every(alive));
controller.abort();
const cancelled = await pending;
assert.equal(cancelled.cancelled, true);
const deadline = Date.now() + 5000;
while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(100);
assert.deepEqual(pids.filter(alive), []);
const timeout = await sandbox.exec("Start-Sleep 120", { signal, timeoutMs: 500 });
assert.equal(timeout.timedOut, true);
await sandbox.dispose();
console.log(
  JSON.stringify({
    result: "PASS",
    root,
    bun: Bun.version,
    arch,
    pids,
    tests: [
      "PowerShell",
      "direct Git",
      "allowed write",
      "denied outside write",
      "denied secret read",
      "native pipeline failure",
      "stdin",
      "network allow/deny",
      "metadata read-only",
      "trusted metadata write",
      "cancellation tree",
      "timeout",
    ],
  }),
);
