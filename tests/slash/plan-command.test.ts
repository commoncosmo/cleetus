import { describe, expect, it } from "bun:test";
import type { PermissionMode } from "../../src/permission/modes";
import type { PermissionRules } from "../../src/permission/types";
import { ProviderRegistry } from "../../src/providers/registry";
import { type CommandDeps, buildCommandRegistry } from "../../src/slash/commands";
import type { SlashContext } from "../../src/slash/types";

function ctx(): SlashContext & { out: string[] } {
  const out: string[] = [];
  return { cwd: "/tmp", print: (t) => out.push(t), out };
}

function baseDeps(over: Partial<CommandDeps>): CommandDeps {
  return {
    providers: new ProviderRegistry(),
    getActive: () => ({ provider: "lm", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    ...over,
  };
}

describe("/plan", () => {
  it("sets the mode to plan", async () => {
    let set: PermissionMode | undefined;
    const reg = buildCommandRegistry(
      baseDeps({
        getMode: () => "normal",
        setMode: (m) => {
          set = m;
        },
      }),
    );
    await reg.get("plan")!.run("", ctx());
    expect(set).toBe("plan");
  });

  it("is hidden when mode deps are absent", () => {
    const reg = buildCommandRegistry(baseDeps({}));
    expect(reg.get("plan")).toBeUndefined();
  });
});
