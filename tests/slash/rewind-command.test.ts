import { describe, expect, it } from "bun:test";
import type { PermissionRules } from "../../src/permission/types";
import { ProviderRegistry } from "../../src/providers/registry";
import { type CommandDeps, buildCommandRegistry } from "../../src/slash/commands";
import type { SlashContext } from "../../src/slash/types";

type Checkpoint = { turnNumber: number; userInput: string; ts: number };

function baseDeps(
  checkpoints: Checkpoint[],
  extra: Partial<Pick<CommandDeps, "rewindToCheckpoint" | "onShowRewind">> = {},
): CommandDeps {
  return {
    providers: new ProviderRegistry(),
    getActive: () => ({ provider: "lm", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    getCheckpoints: () => checkpoints,
    rewindToCheckpoint: extra.rewindToCheckpoint ?? (() => Promise.resolve()),
    onShowRewind: extra.onShowRewind,
  };
}

function ctx(): SlashContext & { out: string[] } {
  const out: string[] = [];
  return { cwd: "/tmp", print: (t) => out.push(t), out };
}

describe("/rewind", () => {
  it("is hidden when getCheckpoints/rewindToCheckpoint deps are absent", () => {
    const reg = buildCommandRegistry({
      providers: new ProviderRegistry(),
      getActive: () => ({ provider: "lm", model: "m" }),
      setActive: () => {},
      getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    });
    expect(reg.get("rewind")).toBeUndefined();
  });

  it("no args + checkpoints exist → calls onShowRewind", async () => {
    let shown = false;
    const reg = buildCommandRegistry(
      baseDeps([{ turnNumber: 1, userInput: "hello", ts: 1000 }], {
        onShowRewind: () => {
          shown = true;
        },
      }),
    );
    const c = ctx();
    await reg.get("rewind")!.run("", c);
    expect(shown).toBe(true);
    expect(c.out).toHaveLength(0);
  });

  it("no args + no checkpoints → prints 'nothing to rewind'", async () => {
    const reg = buildCommandRegistry(baseDeps([]));
    const c = ctx();
    await reg.get("rewind")!.run("", c);
    expect(c.out.join("\n")).toMatch(/nothing to rewind/);
  });

  it("/rewind 2 where 2 is a live turnNumber → calls rewindToCheckpoint(2)", async () => {
    let rewoundTo: number | undefined;
    const reg = buildCommandRegistry(
      baseDeps(
        [
          { turnNumber: 1, userInput: "first", ts: 1000 },
          { turnNumber: 2, userInput: "second", ts: 2000 },
        ],
        {
          rewindToCheckpoint: async (n) => {
            rewoundTo = n;
          },
        },
      ),
    );
    const c = ctx();
    await reg.get("rewind")!.run("2", c);
    expect(rewoundTo).toBe(2);
    expect(c.out.join("\n")).toMatch(/rewound to checkpoint #2/);
  });

  it("no args + checkpoints + no picker → prints the checkpoint list", async () => {
    const reg = buildCommandRegistry(
      baseDeps([
        { turnNumber: 1, userInput: "first", ts: 1000 },
        { turnNumber: 2, userInput: "second", ts: 2000 },
      ]),
    );
    const c = ctx();
    await reg.get("rewind")!.run("", c);
    const out = c.out.join("\n");
    expect(out).toMatch(/1\s+first/);
    expect(out).toMatch(/2\s+second/);
  });

  it.each(["abc", "2.5", "2x"])(
    "/rewind %s (malformed) → rejected, never calls rewindToCheckpoint",
    async (badArg) => {
      let called = false;
      const reg = buildCommandRegistry(
        baseDeps([{ turnNumber: 2, userInput: "second", ts: 2000 }], {
          rewindToCheckpoint: async () => {
            called = true;
          },
        }),
      );
      const c = ctx();
      await reg.get("rewind")!.run(badArg, c);
      expect(called).toBe(false);
      expect(c.out.join("\n")).toMatch(/no checkpoint/);
    },
  );

  it("/rewind 9 where 9 is unknown → prints error with available range", async () => {
    const reg = buildCommandRegistry(
      baseDeps([
        { turnNumber: 1, userInput: "first", ts: 1000 },
        { turnNumber: 2, userInput: "second", ts: 2000 },
      ]),
    );
    const c = ctx();
    await reg.get("rewind")!.run("9", c);
    const out = c.out.join("\n");
    expect(out).toMatch(/no checkpoint #9/);
    expect(out).toMatch(/1, 2/);
  });
});
