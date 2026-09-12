import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoneSandbox } from "../../src/sandbox/none";

const sig = () => new AbortController().signal;

let dir: string;
beforeEach(async () => {
  // realpath resolves macOS symlinks (/var, /tmp) so `pwd` comparisons are exact.
  dir = await realpath(await mkdtemp(join(tmpdir(), "cleetus-none-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("NoneSandbox", () => {
  it("runs a command on the host and captures output", async () => {
    const r = await new NoneSandbox(dir).exec("echo hi", { signal: sig() });
    expect(r.stdout).toContain("hi");
    expect(r.exitCode).toBe(0);
  });

  it("defaults the working directory to the project dir", async () => {
    const r = await new NoneSandbox(dir).exec("pwd", { signal: sig() });
    expect(r.stdout.trim()).toBe(dir);
  });

  it("uses an explicit cwd when given", async () => {
    const r = await new NoneSandbox(dir).exec("pwd", { cwd: "/", signal: sig() });
    expect(r.stdout.trim()).toBe("/");
  });

  it("dispose is a no-op", async () => {
    await new NoneSandbox(dir).dispose(); // must not throw
  });
});
