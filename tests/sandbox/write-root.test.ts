import { describe, expect, it } from "bun:test";
import { AcpSandbox } from "../../src/acp/terminal-sandbox";
import { DockerSandbox } from "../../src/sandbox/docker";
import { HostSandbox } from "../../src/sandbox/host";
import { NoneSandbox } from "../../src/sandbox/none";
import type { SandboxPolicy } from "../../src/sandbox/policy";

const policy: SandboxPolicy = {
  writableExtra: [],
  blockedDirs: [],
  blockedFiles: [],
  network: true,
};

describe("Sandbox.writeRoot", () => {
  it("HostSandbox confines writes to projectDir", () => {
    expect(new HostSandbox("/proj", policy, () => []).writeRoot()).toBe("/proj");
  });

  it("DockerSandbox confines writes to projectDir", () => {
    expect(new DockerSandbox("img", "/proj", true).writeRoot()).toBe("/proj");
  });

  it("NoneSandbox does not confine writes", () => {
    expect(new NoneSandbox("/proj").writeRoot()).toBeNull();
  });

  it("AcpSandbox does not confine writes (editor is the trust boundary)", () => {
    const acp = new AcpSandbox(async () => ({}), "s1", new NoneSandbox("/proj"));
    expect(acp.writeRoot()).toBeNull();
  });
});
