import { describe, expect, it } from "bun:test";
import { acpMcpServersToConfigs } from "../../src/acp/mcp-config";

describe("acpMcpServersToConfigs", () => {
  it("maps ACP mcpServers to NamedServerConfig entries", () => {
    const out = acpMcpServersToConfigs([
      { name: "fs", command: "mcp-fs", args: ["--root", "/p"], env: { A: "1" } },
    ]);
    expect(out).toEqual([
      { name: "fs", command: "mcp-fs", args: ["--root", "/p"], env: { A: "1" }, enabled: true },
    ]);
  });

  it("normalizes ACP EnvVariable[] ({ name, value }[]) to Record<string, string>", () => {
    const out = acpMcpServersToConfigs([
      {
        name: "srv",
        command: "mcp-srv",
        env: [
          { name: "A", value: "1" },
          { name: "KEY", value: "val" },
        ],
      },
    ]);
    expect(out).toEqual([
      { name: "srv", command: "mcp-srv", args: [], env: { A: "1", KEY: "val" }, enabled: true },
    ]);
  });

  it("skips malformed env array entries but keeps valid ones", () => {
    const out = acpMcpServersToConfigs([
      {
        name: "srv",
        command: "mcp-srv",
        env: [
          { name: "GOOD", value: "ok" },
          { name: 42, value: "ignored" }, // name is not a string
          { name: "ALSO_GOOD", value: "yes" },
          "not-an-object", // entirely malformed
        ],
      },
    ]);
    expect(out).toEqual([
      {
        name: "srv",
        command: "mcp-srv",
        args: [],
        env: { GOOD: "ok", ALSO_GOOD: "yes" },
        enabled: true,
      },
    ]);
  });

  it("keeps a plain Record env object (back-compat)", () => {
    const out = acpMcpServersToConfigs([
      { name: "fs", command: "mcp-fs", args: ["--root", "/p"], env: { A: "1" } },
    ]);
    expect(out).toEqual([
      { name: "fs", command: "mcp-fs", args: ["--root", "/p"], env: { A: "1" }, enabled: true },
    ]);
  });

  it("skips malformed entries and a non-array input", () => {
    expect(acpMcpServersToConfigs("nope")).toEqual([]);
    expect(acpMcpServersToConfigs([{ name: "x" }, { command: "y" }])).toEqual([]);
  });

  it("does not let client declarations replace Cleetus-configured server names", () => {
    expect(
      acpMcpServersToConfigs(
        [
          { name: "configured", command: "client-shadow" },
          { name: "client-only", command: "client-mcp" },
        ],
        new Set(["configured"]),
      ),
    ).toEqual([
      {
        name: "client-only",
        command: "client-mcp",
        args: [],
        env: {},
        enabled: true,
      },
    ]);
  });
});
