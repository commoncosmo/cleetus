import { expect, test } from "bun:test";
import type { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";
import type { SlashContext } from "../../src/slash/types";

const baseDeps = {
  providers: {} as ProviderRegistry,
  getActive: () => ({ provider: "p", model: "m" }),
  setActive: () => {},
  getPermissions: () => ({}) as never,
};

function ctx(over: Partial<SlashContext>): SlashContext {
  return { cwd: "/tmp", print: () => {}, ...over };
}

test("/spec is hidden when buildSpecSeed is absent", () => {
  const reg = buildCommandRegistry({ ...baseDeps });
  expect(reg.get("spec")).toBeUndefined();
});

test("/spec seeds the composed turn via runPrompt", async () => {
  let seeded: string | undefined;
  const reg = buildCommandRegistry({ ...baseDeps, buildSpecSeed: (idea) => `SEED(${idea})` });
  const cmd = reg.get("spec")!;
  await cmd.run(
    "a queue",
    ctx({
      runPrompt: async (t) => {
        seeded = t;
      },
    }),
  );
  expect(seeded).toBe("SEED(a queue)");
});

test("/spec prints an interactive-only notice when runPrompt is absent", async () => {
  const lines: string[] = [];
  const reg = buildCommandRegistry({ ...baseDeps, buildSpecSeed: () => "SEED" });
  await reg.get("spec")!.run("x", ctx({ runPrompt: undefined, print: (s) => lines.push(s) }));
  expect(lines.join("\n")).toContain("interactive");
});

test("/spec reports when the skill seed is unavailable", async () => {
  const lines: string[] = [];
  const reg = buildCommandRegistry({ ...baseDeps, buildSpecSeed: () => undefined });
  let ran = false;
  await reg.get("spec")!.run(
    "x",
    ctx({
      runPrompt: async () => {
        ran = true;
      },
      print: (s) => lines.push(s),
    }),
  );
  expect(ran).toBe(false);
  expect(lines.join("\n")).toContain("unavailable");
});
