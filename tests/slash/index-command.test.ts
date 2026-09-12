import { describe, expect, it } from "bun:test";
import { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";

const baseDeps = {
  providers: new ProviderRegistry(),
  getActive: () => ({ provider: "p", model: "m" }),
  setActive: () => {},
  getPermissions: () => ({ project: [], global: [] }),
};

describe("/index command", () => {
  it("registers and forwards args + print to runIndex", async () => {
    const calls: string[] = [];
    const reg = buildCommandRegistry({
      ...baseDeps,
      runIndex: async (args, print) => {
        calls.push(args);
        print("done");
      },
    });
    const cmd = reg.get("index");
    expect(cmd).toBeDefined();
    const out: string[] = [];
    await cmd!.run("rebuild", { cwd: "/", print: (s) => out.push(s) });
    expect(calls).toEqual(["rebuild"]);
    expect(out).toEqual(["done"]);
  });

  it("is hidden when runIndex is not provided", () => {
    const reg = buildCommandRegistry(baseDeps);
    expect(reg.get("index")).toBeUndefined();
  });
});
