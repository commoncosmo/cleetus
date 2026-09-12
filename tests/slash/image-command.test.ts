import { expect, test } from "bun:test";
import { type CommandDeps, buildCommandRegistry } from "../../src/slash/commands";
import type { SlashContext } from "../../src/slash/types";

function baseDeps(extra: Partial<CommandDeps>): CommandDeps {
  return {
    providers: {},
    getActive: () => ({ provider: "p", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({}),
    ...extra,
  } as unknown as CommandDeps;
}
const ctx = (): SlashContext => ({ cwd: "/proj", print: () => {} });

test("/image stages paths, `clear` clears, and no args grabs the clipboard", async () => {
  const staged: string[][] = [];
  let cleared = 0;
  let clip = 0;
  const reg = buildCommandRegistry(
    baseDeps({
      stageImagePaths: async (p: string[]) => {
        staged.push(p);
      },
      clearStagedImages: () => {
        cleared++;
      },
      stageClipboardImage: async () => {
        clip++;
      },
    }),
  );
  await reg.get("image")?.run("./a.png ./b.png", ctx());
  expect(staged[0]).toEqual(["./a.png", "./b.png"]);
  await reg.get("image")?.run("clear", ctx());
  expect(cleared).toBe(1);
  await reg.get("image")?.run("", ctx());
  expect(clip).toBe(1);
});

test("/image is not registered without stageImagePaths wired", () => {
  expect(buildCommandRegistry(baseDeps({})).get("image")).toBeUndefined();
});

test("/image with a quoted path containing a space stages one path", async () => {
  const staged: string[][] = [];
  const reg = buildCommandRegistry(
    baseDeps({
      stageImagePaths: async (p: string[]) => {
        staged.push(p);
      },
    }),
  );
  await reg.get("image")?.run('"/a/b c.png"', ctx());
  expect(staged[0]).toEqual(["/a/b c.png"]);
});

// Regression pin for the staging race: `run` must genuinely `await` `deps.stageImagePaths` /
// `deps.stageClipboardImage` rather than fire-and-forget them. A stub with no real async gap
// (e.g. `async (p) => { staged.push(p) }`) can't distinguish "awaited" from "called and
// ignored" — its body runs synchronously up to its first `await`, so `staged` is already
// populated the instant the stub is *called*, regardless of whether the caller awaits the
// returned promise. These stubs insert a real `setTimeout` gap (a macrotask — guaranteed not to
// resolve during any microtask flush) before mutating `staged`/`clip`, so if `run` ever regresses
// to a bare `deps.stageImagePaths?.(...)` statement (discarding the promise, as it did pre-fix),
// `await run(...)` resolves and returns *before* the timer fires, and the assertion below —
// checked immediately after — fails.
test("/image genuinely awaits staging before the command resolves (regression: previously fire-and-forget)", async () => {
  const staged: string[][] = [];
  let clip = 0;
  const reg = buildCommandRegistry(
    baseDeps({
      stageImagePaths: (p: string[]) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            staged.push(p);
            resolve();
          }, 5);
        }),
      stageClipboardImage: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            clip++;
            resolve();
          }, 5);
        }),
    }),
  );
  await reg.get("image")?.run("./a.png", ctx());
  expect(staged).toEqual([["./a.png"]]);
  await reg.get("image")?.run("", ctx());
  expect(clip).toBe(1);
});
