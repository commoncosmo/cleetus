import { describe, expect, test } from "bun:test";
import { resolveRestoration } from "../../src/checkpoint/resolve";
import type { Checkpoint } from "../../src/checkpoint/types";

function cp(
  turnNumber: number,
  files: [string, { before: string; created: boolean }][],
): Checkpoint {
  return {
    turnNumber,
    userInput: `turn ${turnNumber}`,
    historyLength: turnNumber * 2,
    ts: 0,
    files: new Map(files.map(([p, f]) => [p, { path: p, before: f.before, created: f.created }])),
  };
}

describe("resolveRestoration", () => {
  test("edited file → write its pre-turn content back", () => {
    const steps = resolveRestoration([cp(0, [["/a.ts", { before: "old", created: false }]])]);
    expect(steps).toEqual([{ path: "/a.ts", action: "write", content: "old" }]);
  });

  test("created file → delete", () => {
    const steps = resolveRestoration([cp(0, [["/new.ts", { before: "", created: true }]])]);
    expect(steps).toEqual([{ path: "/new.ts", action: "delete" }]);
  });

  test("earliest snapshot per path wins across multiple undone turns", () => {
    const steps = resolveRestoration([
      cp(0, [["/a.ts", { before: "v0", created: false }]]),
      cp(1, [["/a.ts", { before: "v1", created: false }]]),
    ]);
    expect(steps).toEqual([{ path: "/a.ts", action: "write", content: "v0" }]);
  });

  test("union across turns: each distinct path restored once", () => {
    const steps = resolveRestoration([
      cp(0, [["/a.ts", { before: "a0", created: false }]]),
      cp(1, [["/b.ts", { before: "", created: true }]]),
    ]);
    expect(steps).toContainEqual({ path: "/a.ts", action: "write", content: "a0" });
    expect(steps).toContainEqual({ path: "/b.ts", action: "delete" });
    expect(steps.length).toBe(2);
  });

  test("created-then-edited in the same window stays a delete (first touch wins)", () => {
    const steps = resolveRestoration([
      cp(0, [["/x.ts", { before: "", created: true }]]),
      cp(1, [["/x.ts", { before: "later", created: false }]]),
    ]);
    expect(steps).toEqual([{ path: "/x.ts", action: "delete" }]);
  });

  test("no-edit turns contribute nothing", () => {
    expect(resolveRestoration([cp(0, [])])).toEqual([]);
  });

  test("empty checkpoint list → no steps", () => {
    expect(resolveRestoration([])).toEqual([]);
  });
});
