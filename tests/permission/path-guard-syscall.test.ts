import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fsPromises from "node:fs/promises";

// Pins the perf fix in src/permission/path-guard.ts: resolveReadTarget must return null for
// non-read tools BEFORE calling realpath(projectDir) — not after. A plain return-value
// assertion can't distinguish the two orderings here, because realpath(projectDir) is wrapped
// in try/catch with a resolve() fallback, so even the old (post-realpath) ordering returns null
// for a nonexistent projectDir. Only counting the actual syscall proves the early return runs.
//
// Uses bun:test's `spyOn` on the real "node:fs/promises" module namespace object (NOT
// mock.module) so it can be reliably undone in `afterAll` via `spy.mockRestore()`. Per Bun's
// docs, `mock.module` replacements are NOT undone by `mock.restore()` and leak into other test
// files sharing the same `bun test` process — spyOn on a live module object does not have that
// problem, since mockRestore() puts the original function back on the same object.
//
// This relies on src/permission/path-guard.ts's `import { realpath } from "node:fs/promises"`
// resolving to a live binding against the namespace object's `realpath` property, so that
// spyOn's replacement (installed here, before the dynamic import below) is visible inside
// path-guard.ts. Verified empirically (see the fix report) by temporarily moving the early
// return in resolveReadTarget below the realpath call and confirming this test fails — proof
// the spy genuinely intercepts the call path-guard.ts makes, not just this file's own calls.
const realRealpath = fsPromises.realpath.bind(fsPromises);
const spy = spyOn(fsPromises, "realpath").mockImplementation(realRealpath);

// Must dynamically import AFTER the spy is installed so path-guard.ts's binding resolves
// through the wrapped realpath at call time.
const { resolveReadTarget } = await import("../../src/permission/path-guard");

afterAll(() => {
  spy.mockRestore();
});

describe("resolveReadTarget syscall pin", () => {
  it("triggers zero realpath calls for non-read tools", async () => {
    for (const tool of ["bash", "write_file", "web_fetch", "task"]) {
      spy.mockClear();
      expect(await resolveReadTarget(tool, {}, "/nonexistent/project/dir")).toBeNull();
      expect(spy.mock.calls.length).toBe(0);
    }
  });

  it("triggers at least one realpath call for a read tool (sanity check on the spy)", async () => {
    spy.mockClear();
    const result = await resolveReadTarget("read_file", { path: "x" }, process.cwd());
    expect(result).not.toBeNull();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });
});
