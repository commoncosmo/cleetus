import { describe, expect, test } from "bun:test";
import { type CommandDeps, buildCommandRegistry } from "../../src/slash/commands";
import type { SlashContext } from "../../src/slash/types";

function deps(compactSession?: CommandDeps["compactSession"]): CommandDeps {
  // Only the required CommandDeps fields are stubbed; the whole object is cast,
  // so the stubs just need to exist, not be precisely typed.
  return {
    providers: {},
    getActive: () => ({ provider: "p", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({}),
    compactSession,
  } as unknown as CommandDeps;
}

function ctx(): { ctx: SlashContext; out: string[] } {
  const out: string[] = [];
  return { ctx: { cwd: "/proj", print: (s) => out.push(s) }, out };
}

describe("/compact", () => {
  test("is hidden when compactSession is absent", () => {
    expect(buildCommandRegistry(deps(undefined)).get("compact")).toBeUndefined();
  });

  test("prints the token delta on success", async () => {
    const reg = buildCommandRegistry(
      deps(async () => ({
        compacted: true,
        messagesFolded: 8,
        beforeTokens: 40000,
        afterTokens: 10000,
        partial: false,
      })),
    );
    const { ctx: c, out } = ctx();
    await reg.get("compact")?.run("", c);
    expect(out[0]).toContain("Compacted 8 messages");
    expect(out[0]).toContain("~40k");
    expect(out[0]).toContain("~10k");
    expect(out[0]).toContain("75%");
  });

  test("reports nothing-to-do", async () => {
    const reg = buildCommandRegistry(
      deps(async () => ({
        compacted: false,
        messagesFolded: 0,
        beforeTokens: 500,
        afterTokens: 500,
        partial: false,
      })),
    );
    const { ctx: c, out } = ctx();
    await reg.get("compact")?.run("", c);
    expect(out[0]).toContain("Nothing to compact");
  });

  test("forwards a focus instruction and notes a partial summary", async () => {
    let seen: string | undefined = "UNSET";
    const reg = buildCommandRegistry(
      deps(async (instruction) => {
        seen = instruction;
        return {
          compacted: true,
          messagesFolded: 2,
          beforeTokens: 100,
          afterTokens: 50,
          partial: true,
        };
      }),
    );
    const { ctx: c, out } = ctx();
    await reg.get("compact")?.run("focus on the Tauri config", c);
    expect(seen).toBe("focus on the Tauri config");
    expect(out[0]).toContain("partial summary");
  });
});
