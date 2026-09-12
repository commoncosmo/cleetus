import { describe, expect, it } from "bun:test";
import { buildExecArgs, buildRunArgs } from "../../src/sandbox/docker-args";

describe("docker-args", () => {
  it("builds run args that mount the project dir at the same path and idle", () => {
    expect(buildRunArgs("oven/bun:1", "/Users/example/p", true)).toEqual([
      "run",
      "-d",
      "--rm",
      "--init",
      "-v",
      "/Users/example/p:/Users/example/p",
      "-w",
      "/Users/example/p",
      "oven/bun:1",
      "sleep",
      "infinity",
    ]);
  });

  it("includes --network none after --init when network is false", () => {
    const args = buildRunArgs("oven/bun:1", "/Users/example/p", false);
    expect(args).toContain("--network");
    const networkIdx = args.indexOf("--network");
    expect(args[networkIdx + 1]).toBe("none");
    // --network none must appear right after --init
    const initIdx = args.indexOf("--init");
    expect(networkIdx).toBe(initIdx + 1);
  });

  it("adds -i so stdin is forwarded into the container when a payload is piped", () => {
    expect(buildExecArgs("abc123", "guard.sh", "/p", true, "uuid-1")).toEqual([
      "exec",
      "-i",
      "-w",
      "/p",
      "abc123",
      "setsid",
      "bash",
      "-c",
      "guard.sh #CLEETUS_RUN=uuid-1",
    ]);
  });

  it("builds exec args with the container id, working dir, setsid leader, and marker", () => {
    expect(buildExecArgs("abc123", "ls -la", "/Users/example/p/sub", false, "uuid-2")).toEqual([
      "exec",
      "-w",
      "/Users/example/p/sub",
      "abc123",
      "setsid",
      "bash",
      "-c",
      "ls -la #CLEETUS_RUN=uuid-2",
    ]);
  });
});
