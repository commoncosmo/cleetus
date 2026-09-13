import { describe, expect, it, spyOn } from "bun:test";
import { DockerSandbox } from "../../src/sandbox/docker";
import {
  DEFAULT_DOCKER_IMAGE,
  type FactoryDeps,
  createSandbox,
  createSandboxWithInfo,
  sandboxStatus,
} from "../../src/sandbox/factory";
import { HostSandbox } from "../../src/sandbox/host";
import { NoneSandbox } from "../../src/sandbox/none";

const deps = (over: Partial<FactoryDeps> = {}): FactoryDeps => ({
  platform: "darwin",
  hasBwrap: () => false,
  env: { HOME: "/home/u" },
  preflightHost: async () => null,
  ...over,
});

describe("createSandbox", () => {
  it("returns a NoneSandbox for the none backend", async () => {
    expect(await createSandbox({ backend: "none", network: true }, "/tmp", deps())).toBeInstanceOf(
      NoneSandbox,
    );
  });

  it("returns a DockerSandbox for docker with an explicit image", async () => {
    const sb = (await createSandbox(
      { backend: "docker", image: "myimg", network: true },
      "/tmp",
      deps(),
    )) as DockerSandbox;
    expect(sb).toBeInstanceOf(DockerSandbox);
    expect(sb.image).toBe("myimg");
  });

  it("defaults the docker image to oven/bun:1 when none is set (no throw)", async () => {
    const sb = (await createSandbox(
      { backend: "docker", network: true },
      "/tmp",
      deps(),
    )) as DockerSandbox;
    expect(sb).toBeInstanceOf(DockerSandbox);
    expect(sb.image).toBe(DEFAULT_DOCKER_IMAGE);
    expect(DEFAULT_DOCKER_IMAGE).toBe("oven/bun:1");
  });

  it("returns a DockerSandbox for docker with network: false", async () => {
    const sb = await createSandbox({ backend: "docker", network: false }, "/tmp", deps());
    expect(sb).toBeInstanceOf(DockerSandbox);
  });

  it("returns a HostSandbox for host on macOS", async () => {
    const sb = await createSandbox(
      { backend: "host", network: true },
      "/tmp",
      deps({ platform: "darwin" }),
    );
    expect(sb).toBeInstanceOf(HostSandbox);
  });

  it("returns a HostSandbox for host on Linux when bwrap is present", async () => {
    const sb = await createSandbox(
      { backend: "host", network: true },
      "/tmp",
      deps({ platform: "linux", hasBwrap: () => true }),
    );
    expect(sb).toBeInstanceOf(HostSandbox);
  });

  it("falls back to NoneSandbox (warning once) when host is unavailable", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const sb = await createSandbox(
        { backend: "host", network: true },
        "/tmp",
        deps({ platform: "win32" }),
      );
      expect(sb).toBeInstanceOf(NoneSandbox);
      const warns = spy.mock.calls.filter((c) => String(c[0]).includes("falling back to none"));
      expect(warns.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createSandboxWithInfo degradation signal", () => {
  it("host requested but unavailable → degraded NoneSandbox", async () => {
    const { sandbox, degraded, backend } = await createSandboxWithInfo(
      { backend: "host", network: true },
      "/tmp",
      deps({ platform: "win32", hasBwrap: () => false }),
    );
    expect(sandbox).toBeInstanceOf(NoneSandbox);
    expect(degraded).toBe(true);
    expect(backend).toBe("none");
  });

  it("explicit none → NOT degraded (informed opt-in)", async () => {
    const { sandbox, degraded, backend } = await createSandboxWithInfo(
      { backend: "none", network: true },
      "/tmp",
      deps(),
    );
    expect(sandbox).toBeInstanceOf(NoneSandbox);
    expect(degraded).toBe(false);
    expect(backend).toBe("none");
  });

  it("working host / docker backends → not degraded", async () => {
    expect(
      (await createSandboxWithInfo({ backend: "host", network: true }, "/tmp", deps())).degraded,
    ).toBe(false); // darwin → seatbelt
    expect(
      (await createSandboxWithInfo({ backend: "docker", network: true }, "/tmp", deps())).degraded,
    ).toBe(false);
  });

  it("degrades when the selected host sandbox fails its health check", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const selection = await createSandboxWithInfo(
        { backend: "host", network: true },
        "/tmp",
        deps({ preflightHost: async () => "user namespaces are disabled" }),
      );
      expect(selection.sandbox).toBeInstanceOf(NoneSandbox);
      expect(selection.degraded).toBe(true);
      expect(selection.backend).toBe("none");
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("health check failed"));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("sandboxStatus", () => {
  it("names the active backend and makes degradation visible", () => {
    expect(sandboxStatus("seatbelt", false)).toBe("Sandbox: Seatbelt");
    expect(sandboxStatus("bubblewrap", false)).toBe("Sandbox: bubblewrap");
    expect(sandboxStatus("none", true)).toBe("Sandbox: none (degraded)");
  });
});
