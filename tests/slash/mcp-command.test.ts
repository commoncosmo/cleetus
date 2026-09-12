import { describe, expect, it } from "bun:test";
import type { McpServerStatus } from "../../src/mcp/types";
import { type CommandDeps, buildCommandRegistry } from "../../src/slash/commands";

function depsWith(statuses: McpServerStatus[]): CommandDeps {
  return {
    providers: {
      names: () => [],
      get: () => {
        throw new Error("unused");
      },
    } as unknown as CommandDeps["providers"],
    getActive: () => ({ provider: "p", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({ project: [], global: [] }),
    getMcpStatus: () => statuses,
  };
}

function run(deps: CommandDeps, args = ""): string {
  const reg = buildCommandRegistry(deps);
  let out = "";
  const cmd = reg.get("mcp");
  if (!cmd) throw new Error("no /mcp command registered");
  cmd.run(args, {
    cwd: "/tmp",
    print: (t) => {
      out += t;
    },
  });
  return out;
}

describe("/mcp", () => {
  it("lists connected, failed, and disabled servers", () => {
    const out = run(
      depsWith([
        {
          name: "github",
          state: "connected",
          toolCount: 2,
          toolNames: ["mcp__github__search", "mcp__github__issue"],
        },
        { name: "broken", state: "failed", toolCount: 0, toolNames: [], error: "spawn failed" },
        { name: "off", state: "disabled", toolCount: 0, toolNames: [] },
      ]),
    );
    expect(out).toContain("github");
    expect(out).toContain("connected");
    expect(out).toContain("mcp__github__search");
    expect(out).toContain("broken");
    expect(out).toContain("spawn failed");
    expect(out).toContain("off");
    expect(out).toContain("disabled");
  });

  it("reports when no servers are configured", () => {
    const out = run(depsWith([]));
    expect(out).toContain("No MCP servers configured");
  });

  it("does not register /mcp when getMcpStatus is absent", () => {
    const deps = depsWith([]);
    // biome-ignore lint/performance/noDelete: removing the property entirely is what we're testing (absence)
    delete (deps as { getMcpStatus?: unknown }).getMcpStatus;
    const reg = buildCommandRegistry(deps);
    expect(reg.get("mcp")).toBeUndefined();
  });
});
