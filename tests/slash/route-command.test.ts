import { describe, expect, it } from "bun:test";
import type { RouteMode } from "../../src/agent/route-modes";
import type { PermissionRules } from "../../src/permission/types";
import { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";

function setup(
  initial: RouteMode,
  withTiers: boolean,
  opts: {
    onShowRoute?: () => void;
    lastTier?: "small" | "large" | null;
    lastReason?: string | null;
  } = {},
) {
  let mode: RouteMode = initial;
  const tiers = withTiers
    ? { small: { provider: "lm", model: "s" }, large: { provider: "rm", model: "l" } }
    : undefined;
  const reg = buildCommandRegistry({
    providers: new ProviderRegistry(),
    getActive: () => ({ provider: "lm", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    getRouteMode: () => mode,
    setRouteMode: (m) => {
      mode = m;
    },
    getTiers: () => tiers,
    getLastTier: () => opts.lastTier ?? null,
    getLastReason: () => opts.lastReason ?? null,
    onShowRoute: opts.onShowRoute,
  });
  return { reg, getMode: () => mode };
}

async function run(reg: ReturnType<typeof buildCommandRegistry>, args: string): Promise<string> {
  const out: string[] = [];
  await reg.get("route")!.run(args, { cwd: ".", print: (s) => out.push(s) });
  return out.join("\n");
}

describe("/route", () => {
  it("shows status with a star on the current mode and the tiers", async () => {
    const { reg } = setup("manual", true);
    const text = await run(reg, "");
    expect(text).toContain("* manual");
    expect(text).toContain("tiers: small=s large=l");
  });

  it("switches mode", async () => {
    const { reg, getMode } = setup("manual", true);
    const text = await run(reg, "speed");
    expect(text).toBe("routing mode: speed");
    expect(getMode()).toBe("speed");
  });

  it("rejects speed/smart when no tiers are configured", async () => {
    const { reg, getMode } = setup("manual", false);
    const text = await run(reg, "smart");
    expect(text).toContain("needs routing.tiers");
    expect(getMode()).toBe("manual");
  });

  it("rejects unknown mode names", async () => {
    const { reg } = setup("manual", true);
    const text = await run(reg, "nope");
    expect(text).toContain("unknown route mode");
  });

  it("omits the last-call line when no tier has been used yet", async () => {
    const { reg } = setup("manual", true, { lastTier: null });
    const text = await run(reg, "");
    expect(text).not.toContain("last call:");
  });

  it("shows the last decision's reason alongside its tier", async () => {
    const { reg } = setup("smart", true, {
      lastTier: "large",
      lastReason: "smart: escalated (broad_code)",
    });
    const text = await run(reg, "");
    expect(text).toContain("last call: large tier — smart: escalated (broad_code)");
  });

  it("shows just the tier when no reason is available", async () => {
    const { reg } = setup("smart", true, { lastTier: "small", lastReason: null });
    const text = await run(reg, "");
    const lastCallLine = text.split("\n").find((line) => line.startsWith("last call:"));
    expect(lastCallLine).toBe("last call: small tier");
  });

  it("opens the picker instead of printing status when onShowRoute is set", async () => {
    let opened = false;
    const { reg } = setup("manual", true, {
      onShowRoute: () => {
        opened = true;
      },
    });
    const text = await run(reg, "");
    expect(opened).toBe(true);
    expect(text).toBe(""); // picker path prints nothing
  });
});
