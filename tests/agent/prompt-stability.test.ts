import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { renderEnvironment } from "../../src/agent/environment";

describe("environment is deterministic under a pinned clock", () => {
  it("byte-identical output for repeated calls with the same clock", () => {
    const pinned = new Date(2026, 6, 21);
    expect(renderEnvironment("/proj", "darwin", pinned)).toBe(
      renderEnvironment("/proj", "darwin", pinned),
    );
  });

  it("the clock reaches BOTH the date line and the search-guidance year", () => {
    const a = renderEnvironment("/proj", "darwin", new Date(2026, 6, 21));
    const b = renderEnvironment("/proj", "darwin", new Date(2027, 6, 21));
    expect(a).toContain("2026-07-21");
    expect(a).toContain('"<topic> 2026"');
    expect(b).toContain('"<topic> 2027"');
  });
});

// Source-scan guard (repo precedent: tests/ui/no-hardcoded-colors-*.test.ts): every
// renderEnvironment call in the two entrypoints must pass the session-pinned clock —
// a bare renderEnvironment(projectDir) re-reads the wall clock per turn and invalidates
// the whole KV prefix cache at date rollover (audit F3).
describe("entrypoints pass the session-pinned clock", () => {
  for (const file of ["src/bin/cleetus.ts", "src/acp/runtime.ts"]) {
    it(`${file} pins renderEnvironment to sessionClock`, () => {
      const src = readFileSync(file, "utf8");
      const calls = src.match(/renderEnvironment\([^)]*\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).toContain("sessionClock");
      expect(src).toContain("const sessionClock = new Date()");
    });
  }
});

describe("plan mode stays out of the system prompt (audit F4)", () => {
  it("no entrypoint threads PLAN_MODE_PROMPT into buildSystemPrompt", () => {
    for (const file of ["src/bin/cleetus.ts", "src/acp/runtime.ts"]) {
      expect(readFileSync(file, "utf8")).not.toContain("PLAN_MODE_PROMPT");
    }
  });

  it("buildSystemPrompt has no planMode fragment", () => {
    expect(readFileSync("src/agent/system-prompt.ts", "utf8")).not.toContain("planMode");
  });
});
