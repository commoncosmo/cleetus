import { describe, expect, it } from "bun:test";
import type { PermissionRules } from "../../src/permission/types";
import { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";

function setup(initial: number) {
  let value = initial;
  const reg = buildCommandRegistry({
    providers: new ProviderRegistry(),
    getActive: () => ({ provider: "lm", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    getMaxLoops: () => value,
    setMaxLoops: (n) => {
      value = n === 0 ? Number.POSITIVE_INFINITY : n;
    },
  });
  return { reg, get: () => value };
}

async function run(reg: ReturnType<typeof buildCommandRegistry>, args: string): Promise<string> {
  const out: string[] = [];
  await reg.get("maxloops")!.run(args, { cwd: ".", print: (s) => out.push(s) });
  return out.join("\n");
}

describe("/maxloops", () => {
  it("sets a numeric limit", async () => {
    const { reg, get } = setup(100);
    const out = await run(reg, "250");
    expect(get()).toBe(250);
    expect(out).toContain("250");
  });
  it("treats 0 as unlimited", async () => {
    const { reg, get } = setup(100);
    const out = await run(reg, "0");
    expect(get()).toBe(Number.POSITIVE_INFINITY);
    expect(out.toLowerCase()).toContain("unlimited");
  });
  it("accepts the explicit unlimited spelling", async () => {
    const { reg, get } = setup(100);
    const out = await run(reg, "unlimited");
    expect(get()).toBe(Number.POSITIVE_INFINITY);
    expect(out.toLowerCase()).toContain("unlimited");
  });
  it("rejects a non-integer without changing the limit", async () => {
    const { reg, get } = setup(100);
    const out = await run(reg, "abc");
    expect(get()).toBe(100);
    expect(out.toLowerCase()).toContain("invalid");
  });
  it("shows the current limit with no args", async () => {
    const { reg } = setup(100);
    expect(await run(reg, "")).toContain("100");
  });
});
