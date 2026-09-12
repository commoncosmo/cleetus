import { describe, expect, it } from "bun:test";
import type { EffortLevel } from "../../src/agent/effort";
import type { PermissionRules } from "../../src/permission/types";
import { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";

function setup(initial: EffortLevel, opts: { onShowEffort?: () => void } = {}) {
  let level: EffortLevel = initial;
  const reg = buildCommandRegistry({
    providers: new ProviderRegistry(),
    getActive: () => ({ provider: "lm", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    getEffort: () => level,
    setEffort: (l) => {
      level = l;
    },
    onShowEffort: opts.onShowEffort,
  });
  return { reg, getLevel: () => level };
}

async function run(reg: ReturnType<typeof buildCommandRegistry>, args: string): Promise<string> {
  const out: string[] = [];
  await reg.get("effort")!.run(args, { cwd: ".", print: (s) => out.push(s) });
  return out.join("\n");
}

describe("/effort", () => {
  it("shows status with a star on the current level", async () => {
    const { reg } = setup("medium");
    const out = await run(reg, "");
    expect(out).toMatch(/\* medium/);
    expect(out).toMatch(/high/);
  });

  it("opens the picker when onShowEffort is provided and no arg is given", async () => {
    let opened = false;
    const { reg } = setup("medium", {
      onShowEffort: () => {
        opened = true;
      },
    });
    await run(reg, "");
    expect(opened).toBe(true);
  });

  it("switches level on a valid id (and prefix)", async () => {
    const { reg, getLevel } = setup("medium");
    const out = await run(reg, "h");
    expect(getLevel()).toBe("high");
    expect(out).toMatch(/effort: high/);
  });

  it("errors on an unknown level and lists valid ids", async () => {
    const { reg, getLevel } = setup("medium");
    const out = await run(reg, "turbo");
    expect(getLevel()).toBe("medium");
    expect(out).toMatch(/unknown effort/);
    expect(out).toMatch(/low, medium, high/);
  });

  it("hides the command when effort deps are absent", () => {
    const reg = buildCommandRegistry({
      providers: new ProviderRegistry(),
      getActive: () => ({ provider: "lm", model: "m" }),
      setActive: () => {},
      getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    });
    expect(reg.get("effort")).toBeUndefined();
  });
});
