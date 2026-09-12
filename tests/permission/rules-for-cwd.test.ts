import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRulesForCwd } from "../../src/permission/loader";

function projWithRule(decision: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rfc-"));
  mkdirSync(join(dir, ".cleetus"), { recursive: true });
  writeFileSync(
    join(dir, ".cleetus", "permissions.yaml"),
    `rules:\n  - tool: bash\n    args_pattern: "evil"\n    decision: ${decision}\n`,
  );
  return dir;
}

describe("makeRulesForCwd", () => {
  it("loads the project layer from the given cwd", async () => {
    const cwd = projWithRule("deny");
    const rulesFor = makeRulesForCwd(join(mkdtempSync(join(tmpdir(), "g-")), "permissions.yaml"));
    const rules = await rulesFor(cwd);
    expect(rules.project).toEqual([{ tool: "bash", argsPattern: "evil", decision: "deny" }]);
  });

  it("caches per cwd (same object back) and keeps distinct cwds distinct", async () => {
    const a = projWithRule("deny");
    const b = projWithRule("ask");
    const rulesFor = makeRulesForCwd(join(mkdtempSync(join(tmpdir(), "g-")), "permissions.yaml"));
    expect(await rulesFor(a)).toBe(await rulesFor(a));
    expect((await rulesFor(b)).project[0]!.decision).toBe("ask");
  });

  it("evicts a failed load so a fixed file recovers", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rfc-"));
    mkdirSync(join(cwd, ".cleetus"), { recursive: true });
    writeFileSync(join(cwd, ".cleetus", "permissions.yaml"), "rules: [ {broken");
    const rulesFor = makeRulesForCwd(join(mkdtempSync(join(tmpdir(), "g-")), "permissions.yaml"));
    // Await the rejection fully (including the catch-eviction microtask) before touching the
    // file again — otherwise the sync writeFileSync below can race the async read and this test
    // would pass without ever exercising eviction.
    await expect(rulesFor(cwd)).rejects.toThrow();
    // Fix with content DIFFERENT from empty so the final assertion can't pass coincidentally
    // (e.g. from a stale cached value or an unevicted rejection resolving to `[]` by accident) —
    // only a genuine fresh load returns this specific rule.
    writeFileSync(
      join(cwd, ".cleetus", "permissions.yaml"),
      'rules:\n  - tool: bash\n    args_pattern: "evil"\n    decision: ask\n',
    );
    expect((await rulesFor(cwd)).project).toEqual([
      { tool: "bash", argsPattern: "evil", decision: "ask" },
    ]);
  });
});
