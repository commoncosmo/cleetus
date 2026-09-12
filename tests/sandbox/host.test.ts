import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEETUS_SANDBOX_ACTIVE_ENV, HostSandbox } from "../../src/sandbox/host";
import type { SandboxPolicy } from "../../src/sandbox/policy";

const sig = () => new AbortController().signal;
const policy: SandboxPolicy = {
  writableExtra: [],
  blockedDirs: [],
  blockedFiles: [],
  network: true,
};
const noopPrefix = () => []; // run bash directly on the host

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "cleetus-host-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("HostSandbox", () => {
  it("runs a command via the provider prefix and captures output", async () => {
    const r = await new HostSandbox(dir, policy, noopPrefix).exec("echo hi", { signal: sig() });
    expect(r.stdout).toContain("hi");
    expect(r.exitCode).toBe(0);
  });

  it("defaults the working directory to the project dir", async () => {
    const r = await new HostSandbox(dir, policy, noopPrefix).exec("pwd", { signal: sig() });
    expect(r.stdout.trim()).toBe(dir);
  });

  it("prepends the provider prefix to the argv", async () => {
    // `env` as the prefix turns the command into `env bash -c 'echo hi'` → still prints hi.
    const r = await new HostSandbox(dir, policy, () => ["env"]).exec("echo hi", { signal: sig() });
    expect(r.stdout).toContain("hi");
    expect(r.exitCode).toBe(0);
  });

  it("marks commands as running inside the host sandbox", async () => {
    const r = await new HostSandbox(dir, policy, noopPrefix).exec(
      `printf %s "$${CLEETUS_SANDBOX_ACTIVE_ENV}"`,
      { signal: sig() },
    );
    expect(r.stdout).toBe("host");
  });

  it("adds project metadata protection only for model-authored Bash executions", async () => {
    const seen: SandboxPolicy[] = [];
    const sandbox = new HostSandbox(dir, policy, (_projectDir, effective) => {
      seen.push(effective);
      return [];
    });
    await sandbox.exec("echo guarded", { signal: sig(), protectProjectMetadata: true });
    await sandbox.exec("echo trusted", { signal: sig() });
    expect(seen[0]?.protectedProjectPaths).toEqual([".git", ".cleetus"]);
    expect(seen[1]?.protectedProjectPaths ?? []).toEqual([]);
  });

  it("uses an explicit cwd when given", async () => {
    const r = await new HostSandbox(dir, policy, noopPrefix).exec("pwd", {
      cwd: "/",
      signal: sig(),
    });
    expect(r.stdout.trim()).toBe("/");
  });

  it("dispose is a no-op", async () => {
    await new HostSandbox(dir, policy, noopPrefix).dispose(); // must not throw
  });
});
