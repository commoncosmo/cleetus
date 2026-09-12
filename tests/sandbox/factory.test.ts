import { describe, expect, it, spyOn } from "bun:test";
import { DockerSandbox } from "../../src/sandbox/docker";
import {
  DEFAULT_DOCKER_IMAGE,
  type FactoryDeps,
  createSandbox,
  createSandboxWithInfo,
} from "../../src/sandbox/factory";
import { HostSandbox } from "../../src/sandbox/host";
import { NoneSandbox } from "../../src/sandbox/none";

const deps = (over: Partial<FactoryDeps> = {}): FactoryDeps => ({
  platform: "darwin",
  hasBwrap: () => false,
  env: { HOME: "/home/u" },
  ...over,
});

describe("createSandbox", () => {
  it("returns a NoneSandbox for the none backend", () => {
    expect(createSandbox({ backend: "none", network: true }, "/tmp", deps())).toBeInstanceOf(
      NoneSandbox,
    );
  });

  it("returns a DockerSandbox for docker with an explicit image", () => {
    const sb = createSandbox(
      { backend: "docker", image: "myimg", network: true },
      "/tmp",
      deps(),
    ) as DockerSandbox;
    expect(sb).toBeInstanceOf(DockerSandbox);
    expect(sb.image).toBe("myimg");
  });

  it("defaults the docker image to oven/bun:1 when none is set (no throw)", () => {
    const sb = createSandbox({ backend: "docker", network: true }, "/tmp", deps()) as DockerSandbox;
    expect(sb).toBeInstanceOf(DockerSandbox);
    expect(sb.image).toBe(DEFAULT_DOCKER_IMAGE);
    expect(DEFAULT_DOCKER_IMAGE).toBe("oven/bun:1");
  });

  it("returns a DockerSandbox for docker with network: false", () => {
    const sb = createSandbox({ backend: "docker", network: false }, "/tmp", deps());
    expect(sb).toBeInstanceOf(DockerSandbox);
  });

  it("returns a HostSandbox for host on macOS", () => {
    const sb = createSandbox(
      { backend: "host", network: true },
      "/tmp",
      deps({ platform: "darwin" }),
    );
    expect(sb).toBeInstanceOf(HostSandbox);
  });

  it("returns a HostSandbox for host on Linux when bwrap is present", () => {
    const sb = createSandbox(
      { backend: "host", network: true },
      "/tmp",
      deps({ platform: "linux", hasBwrap: () => true }),
    );
    expect(sb).toBeInstanceOf(HostSandbox);
  });

  it("falls back to NoneSandbox (warning once) when host is unavailable", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const sb = createSandbox(
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
  it("host requested but unavailable → degraded NoneSandbox", () => {
    const { sandbox, degraded } = createSandboxWithInfo(
      { backend: "host", network: true },
      "/tmp",
      deps({ platform: "win32", hasBwrap: () => false }),
    );
    expect(sandbox).toBeInstanceOf(NoneSandbox);
    expect(degraded).toBe(true);
  });

  it("explicit none → NOT degraded (informed opt-in)", () => {
    const { sandbox, degraded } = createSandboxWithInfo(
      { backend: "none", network: true },
      "/tmp",
      deps(),
    );
    expect(sandbox).toBeInstanceOf(NoneSandbox);
    expect(degraded).toBe(false);
  });

  it("working host / docker backends → not degraded", () => {
    expect(createSandboxWithInfo({ backend: "host", network: true }, "/tmp", deps()).degraded).toBe(
      false,
    ); // darwin → seatbelt
    expect(
      createSandboxWithInfo({ backend: "docker", network: true }, "/tmp", deps()).degraded,
    ).toBe(false);
  });
});
