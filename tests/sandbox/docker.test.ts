import { describe, expect, it, spyOn } from "bun:test";
import { DockerSandbox } from "../../src/sandbox/docker";
import { SandboxUnavailableError } from "../../src/sandbox/types";

const sig = () => new AbortController().signal;
const BOGUS = "cleetus-no-such-docker-binary-xyz";

describe("DockerSandbox fail-closed", () => {
  it("throws SandboxUnavailableError when the docker binary is missing", async () => {
    const sb = new DockerSandbox("img", "/tmp", true, BOGUS);
    await expect(sb.exec("echo hi", { signal: sig() })).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
  });

  it("caches the start failure (second exec also throws, no retry storm)", async () => {
    const sb = new DockerSandbox("img", "/tmp", true, BOGUS);
    await expect(sb.exec("echo a", { signal: sig() })).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    await expect(sb.exec("echo b", { signal: sig() })).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
  });

  it("dispose is safe when no container ever started", async () => {
    const sb = new DockerSandbox("img", "/tmp", true, BOGUS);
    await sb.dispose(); // must not throw
  });

  it("logs the failure reason once to stderr on first start failure", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const sb = new DockerSandbox("img", "/tmp", true, BOGUS);
      await sb.exec("echo a", { signal: sig() }).catch(() => {});
      await sb.exec("echo b", { signal: sig() }).catch(() => {});
      const sandboxLogs = spy.mock.calls.filter((c) =>
        String(c[0]).includes("sandbox unavailable"),
      );
      expect(sandboxLogs.length).toBe(1); // logged once, not per-exec
    } finally {
      spy.mockRestore();
    }
  });

  it("shares one start attempt across concurrent first execs (all fail-closed together)", async () => {
    const sb = new DockerSandbox("img", "/tmp", true, BOGUS);
    const results = await Promise.allSettled([
      sb.exec("echo a", { signal: sig() }),
      sb.exec("echo b", { signal: sig() }),
      sb.exec("echo c", { signal: sig() }),
    ]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SandboxUnavailableError);
    }
  });
});
