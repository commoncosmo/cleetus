import { describe, expect, test } from "bun:test";
import { type CommandDeps, buildCommandRegistry } from "../../src/slash/commands";
import type { SlashContext } from "../../src/slash/types";

function deps(forkSession?: CommandDeps["forkSession"]): CommandDeps {
  // Only the required CommandDeps fields are stubbed; the whole object is cast,
  // so the stubs just need to exist, not be precisely typed.
  return {
    providers: {},
    getActive: () => ({ provider: "p", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({}),
    forkSession,
  } as unknown as CommandDeps;
}

function ctx(): { ctx: SlashContext; out: string[] } {
  const out: string[] = [];
  return { ctx: { cwd: "/proj", print: (s) => out.push(s) }, out };
}

describe("/fork", () => {
  test("reports the forked session id and resume hint", async () => {
    const reg = buildCommandRegistry(deps(() => ({ id: "NEWID" })));
    const { ctx: c, out } = ctx();
    await reg.get("fork")?.run("", c);
    const text = out.join("\n");
    expect(text).toContain("NEWID");
    expect(text).toContain("--resume NEWID");
  });

  test("when forkSession returns null, says there is nothing to fork yet", async () => {
    const reg = buildCommandRegistry(deps(() => null));
    const { ctx: c, out } = ctx();
    await reg.get("fork")?.run("", c);
    expect(out.join("\n")).toContain("nothing to fork");
  });

  test("without forkSession wired (non-interactive), the command is not registered", () => {
    const reg = buildCommandRegistry(deps(undefined));
    expect(reg.get("fork")).toBeUndefined();
  });
});
