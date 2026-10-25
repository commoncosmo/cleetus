import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

process.env.MXC_FFI_DIR = join(dirname(process.execPath), "native");
const sdkPath = join(dirname(process.execPath), "node_modules/@microsoft/mxc-sdk/dist/v1/index.js");
const { getPlatformSupport, probe, run, spawn } = process.argv.includes("--executor")
  ? await import("./executor")
  : await import(sdkPath);
const root = resolve(process.argv[3] ?? "dist/mxc-poc/results", `${Date.now()}`);
const project = join(root, "project");
const outside = join(root, "outside");
const secret = join(project, "secret");
for (const p of [project, outside, secret]) mkdirSync(p, { recursive: true });
writeFileSync(join(outside, "sentinel.txt"), "unchanged");
writeFileSync(join(secret, "sentinel.txt"), "secret");
const worker = (mode: string) =>
  [process.execPath, "--mxc-worker", mode, project, outside].map((s) => `"${s}"`).join(" ");
const request = (script: string) => ({
  command: worker(script === "parent" ? "parent" : "filesystem"),
  containment: { type: "processcontainer" as const },
  workingDirectory: project,
  filesystem: {
    readwritePaths: [project],
    readonlyPaths: [process.env.SystemRoot!, dirname(process.execPath)],
    deniedPaths: [secret],
    clearPolicyOnExit: true,
  },
  network: { egress: { default: "deny" as const } },
  timeoutMs: 20000,
});
console.log(
  JSON.stringify(
    { bun: Bun.version, arch: process.arch, root, support: getPlatformSupport(), probe: probe() },
    null,
    2,
  ),
);
const result = await run(request("filesystem"));
console.log("filesystem", JSON.stringify(result));
assert.equal(result.exitCode, 0);
assert.match(result.stdout, /FILESYSTEM_PASS/);
assert.equal(readFileSync(join(project, "allowed.txt"), "utf8"), "allowed");
assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "unchanged");

// Wait for descendant readiness instead of a fixed startup delay.
const proc = await spawn(request("parent"));
let stdout = "",
  stderr = "";
proc.standardOutput?.on("data", (b) => {
  stdout += b.toString();
});
proc.standardError?.on("data", (b) => {
  stderr += b.toString();
});
const controller = new AbortController();
controller.signal.addEventListener("abort", () => proc.kill(), { once: true });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
try {
  const deadline = Date.now() + 15000;
  while (!existsSync(join(project, "grandchild.pid")) && Date.now() < deadline)
    await Bun.sleep(100);
  assert.ok(existsSync(join(project, "grandchild.pid")), `descendant not ready: ${stderr}`);
  const pids = [
    proc.id,
    ...["parent.pid", "child.pid", "grandchild.pid"].map((p) =>
      Number(readFileSync(join(project, p), "utf8")),
    ),
  ];
  assert.ok(
    pids.every((p) => p > 0 && alive(p)),
    "all processes must be alive before cancellation",
  );
  controller.abort();
  const outcome = await proc.wait();
  const reapDeadline = Date.now() + 5000;
  while (pids.some(alive) && Date.now() < reapDeadline) await Bun.sleep(100);
  assert.deepEqual(pids.filter(alive), [], "cancellation left survivors");
  console.log(JSON.stringify({ cancellation: "PASS", pids, outcome, stdout, stderr }));
} finally {
  proc.kill();
  proc.dispose();
}
console.log("MXC_POC_PASS");
