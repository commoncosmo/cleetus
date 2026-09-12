import { describe, expect, it } from "bun:test";
import { DockerSandbox } from "../../src/sandbox/docker";

async function dockerAvailable(): Promise<boolean> {
  try {
    const p = Bun.spawn(["docker", "version"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

// Opt-in: these hit a real Docker daemon and pull `bash:latest` from a registry, which is
// network-flaky on CI. Run them deliberately with `CLEETUS_DOCKER_TESTS=1 bun test`; otherwise
// (including in CI) they skip, so the pull can never redden the gate.
const HAS_DOCKER = !!process.env.CLEETUS_DOCKER_TESTS && (await dockerAvailable());
const sig = () => new AbortController().signal;

describe.skipIf(!HAS_DOCKER)("DockerSandbox (integration, requires Docker)", () => {
  it("runs a command in the container and disposes it", async () => {
    // `bash:latest` is a tiny official image that has bash; docker run auto-pulls it.
    const sb = new DockerSandbox("bash:latest", "/tmp");
    try {
      const r = await sb.exec("echo hi", { signal: sig() });
      expect(r.stdout).toContain("hi");
      expect(r.exitCode).toBe(0);
    } finally {
      await sb.dispose();
    }
  }, 120_000); // allow time for an image pull on first run

  it("kills the in-container process tree when a command times out", async () => {
    const sb = new DockerSandbox("bash:latest", "/tmp");
    try {
      // Start a background sleeper inside the container, print its PID, then block.
      const r = await sb.exec("sleep 60 & echo INNER=$!; wait", { timeoutMs: 1000, signal: sig() });
      expect(r.timedOut).toBe(true);
      const inner = Number((r.stdout.match(/INNER=(\d+)/) ?? [])[1]);
      expect(inner).toBeGreaterThan(0);
      // After teardown the in-container sleeper must be gone: `kill -0` returns non-zero.
      const probe = await sb.exec(`kill -0 ${inner} 2>/dev/null; echo EXIT=$?`, { signal: sig() });
      expect(probe.stdout).toContain("EXIT=1");
      // survivors must be undefined (not a stray host pid) — docker teardown is authoritative
      expect(r.survivors).toBeUndefined();
      expect(r.survivors ?? []).toEqual([]);
    } finally {
      await sb.dispose();
    }
  }, 30_000);
});
