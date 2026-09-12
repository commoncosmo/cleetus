import { describe, expect, it } from "bun:test";
import { spawnCollect, verifyGroupDead } from "../../src/sandbox/spawn";

const sig = () => new AbortController().signal;

describe("spawnCollect", () => {
  it("captures stdout and a zero exit", async () => {
    const r = await spawnCollect(["bash", "-c", "echo hello"], { signal: sig() });
    expect(r.stdout).toContain("hello");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.cancelled).toBe(false);
  });

  it("reports a non-zero exit code", async () => {
    const r = await spawnCollect(["bash", "-c", "exit 3"], { signal: sig() });
    expect(r.exitCode).toBe(3);
  });

  it("marks timedOut when the command exceeds timeoutMs", async () => {
    const r = await spawnCollect(["bash", "-c", "sleep 10"], { timeoutMs: 200, signal: sig() });
    expect(r.timedOut).toBe(true);
  });

  it("marks cancelled when the signal aborts", async () => {
    const ac = new AbortController();
    const p = spawnCollect(["bash", "-c", "sleep 10"], { signal: ac.signal });
    ac.abort();
    const r = await p;
    expect(r.cancelled).toBe(true);
  });

  it("captures stderr", async () => {
    const r = await spawnCollect(["bash", "-c", "echo oops >&2"], { signal: sig() });
    expect(r.stderr).toContain("oops");
    expect(r.exitCode).toBe(0);
  });

  it("captures output written before a timeout kill", async () => {
    const r = await spawnCollect(["bash", "-c", "echo early; sleep 10"], {
      timeoutMs: 300,
      signal: sig(),
    });
    expect(r.stdout).toContain("early");
    expect(r.timedOut).toBe(true);
  });

  it("marks cancelled when the signal is already aborted before the call", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await spawnCollect(["bash", "-c", "echo hi"], { signal: ac.signal });
    expect(r.cancelled).toBe(true);
  });

  it("captures full stdout for large normal output (no truncation)", async () => {
    const r = await spawnCollect(["bash", "-c", "for i in $(seq 1 5000); do echo line$i; done"], {
      signal: sig(),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("line5000"); // tail not truncated
    expect(r.stdout.split("\n").filter(Boolean).length).toBe(5000);
  });

  it("returns empty output for a silent non-zero exit", async () => {
    const r = await spawnCollect(["bash", "-c", "exit 7"], { signal: sig() });
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("never reports both cancelled and timedOut (abort supersedes)", async () => {
    const ac = new AbortController();
    const p = spawnCollect(["bash", "-c", "sleep 10"], { timeoutMs: 50, signal: ac.signal });
    ac.abort();
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it("bounds the post-exit drain when a grandchild holds the pipe open", async () => {
    const start = Date.now();
    const r = await spawnCollect(["bash", "-c", "(sleep 30 &) ; echo done"], { signal: sig() });
    expect(r.stdout).toContain("done");
    expect(Date.now() - start).toBeLessThan(5000); // bounded by the grace, not 30s
  }, 10_000);

  it("rejects when the executable does not exist", async () => {
    await expect(spawnCollect(["cleetus-no-such-binary-xyz"], { signal: sig() })).rejects.toThrow();
  });

  // Regression: a timed-out command that spawned a long-lived grandchild (e.g. a dev
  // server tree: `bun tauri dev` → node → vite) must not leak the grandchild. Killing
  // only the direct child orphaned the rest, which kept holding the dev-server port.
  const grandchildAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("kills the whole process group on a timeout (no orphaned grandchild)", async () => {
    // Print the grandchild PID, then both parent and grandchild sleep past the timeout.
    const r = await spawnCollect(["bash", "-c", "sleep 30 & echo GC=$!; wait"], {
      timeoutMs: 300,
      signal: sig(),
    });
    expect(r.timedOut).toBe(true);
    const pid = Number((r.stdout.match(/GC=(\d+)/) ?? [])[1]);
    expect(pid).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 400)); // allow the kill to propagate
    const alive = grandchildAlive(pid);
    if (alive) process.kill(pid, "SIGKILL"); // don't leak from the test itself
    expect(alive).toBe(false);
  }, 10_000);

  it("kills the whole process group on an abort (no orphaned grandchild)", async () => {
    const ac = new AbortController();
    const p = spawnCollect(["bash", "-c", "sleep 30 & echo GC=$!; wait"], { signal: ac.signal });
    await new Promise((res) => setTimeout(res, 200)); // let the grandchild start & print
    ac.abort();
    const r = await p;
    expect(r.cancelled).toBe(true);
    const pid = Number((r.stdout.match(/GC=(\d+)/) ?? [])[1]);
    expect(pid).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 400));
    const alive = grandchildAlive(pid);
    if (alive) process.kill(pid, "SIGKILL");
    expect(alive).toBe(false);
  }, 10_000);

  it("verifies the group is dead after a timeout kill (no survivors reported)", async () => {
    const r = await spawnCollect(["bash", "-c", "sleep 30 & echo GC=$!; wait"], {
      timeoutMs: 300,
      signal: sig(),
    });
    expect(r.timedOut).toBe(true);
    // SIGKILL reaps the group within the verify window → nothing survives.
    expect(r.survivors ?? []).toEqual([]);
  }, 10_000);

  it("leaves survivors undefined on a normal exit", async () => {
    const r = await spawnCollect(["bash", "-c", "echo hi"], { signal: sig() });
    expect(r.survivors).toBeUndefined();
  });
});

describe("verifyGroupDead", () => {
  const noKill = () => {};
  const noSleep = async () => {};

  it("returns [] when the group is already dead (ESRCH from the first probe)", async () => {
    const survivors = await verifyGroupDead(1234, {
      isAlive: () => false,
      kill: noKill,
      sleep: noSleep,
    });
    expect(survivors).toEqual([]);
  });

  it("returns [] when the group dies during the window", async () => {
    let calls = 0;
    const isAlive = () => ++calls < 3; // alive, alive, then dead
    const survivors = await verifyGroupDead(1234, {
      isAlive,
      kill: noKill,
      sleep: noSleep,
      windowMs: 1000,
      intervalMs: 1,
    });
    expect(survivors).toEqual([]);
  });

  it("reports the leader pid when the group never dies within the window", async () => {
    const survivors = await verifyGroupDead(1234, {
      isAlive: () => true,
      kill: noKill,
      sleep: noSleep,
      windowMs: 5,
      intervalMs: 1,
    });
    expect(survivors).toEqual([1234]);
  });

  it("re-sends SIGKILL each interval while the group is alive", async () => {
    let kills = 0;
    await verifyGroupDead(1234, {
      isAlive: () => true,
      kill: () => {
        kills++;
      },
      sleep: noSleep,
      windowMs: 5,
      intervalMs: 1,
    });
    expect(kills).toBeGreaterThan(0);
  });
});
