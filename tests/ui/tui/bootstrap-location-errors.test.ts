import { expect, test } from "bun:test";

// Exercise the production callback with a failing turn, independent of Ink and a
// live model server. This is the callback used by the initial location picker.
const source = await Bun.file(new URL("../../../src/ui/tui/app.tsx", import.meta.url)).text();
const start = source.indexOf("  async function resolveBootstrapLocation(");
const end = source.indexOf("\n  async function approveTaskList()", start);
if (start < 0 || end < 0) throw new Error("Bootstrap location callback not found");
const callback = new Bun.Transpiler({ loader: "tsx" }).transformSync(source.slice(start, end));

test("a rejected bootstrap turn settles the picker callback and permits another turn", async () => {
  const stash = { current: { kind: "single", text: "Build the site" } as object | null };
  const busy: boolean[] = [];
  let turns = 0;
  const resolveLocation = new Function(
    "bootstrapStashRef",
    "setBootstrapLocationPending",
    "beginBusy",
    "setBusy",
    "runPrompt",
    `${callback}; return resolveBootstrapLocation;`,
  )(
    stash,
    () => {},
    () => busy.push(true),
    (value: boolean) => busy.push(value),
    async () => {
      if (++turns === 1) throw new Error("The socket connection was closed unexpectedly.");
    },
  ) as (location: { kind: "cwd" }) => Promise<void>;

  await expect(resolveLocation({ kind: "cwd" })).resolves.toBeUndefined();
  expect(stash.current).toBeNull();
  stash.current = { kind: "single", text: "Continue" };
  await expect(resolveLocation({ kind: "cwd" })).resolves.toBeUndefined();
  expect(turns).toBe(2);
  expect(busy).toEqual([true, false, true, false]);
});
