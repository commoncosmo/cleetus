import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSystemPromptOverride } from "../../src/agent/system-prompt-override";
import { CleetusError } from "../../src/lib/errors";

describe("loadSystemPromptOverride", () => {
  it("returns null when the key is unset", async () => {
    expect(await loadSystemPromptOverride(undefined)).toBeNull();
  });

  it("returns file contents verbatim (trailing newline preserved)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spo-"));
    const p = join(dir, "prompt.txt");
    writeFileSync(p, "You are a pirate.\n");
    expect(await loadSystemPromptOverride(p)).toBe("You are a pirate.\n");
  });

  it("throws CONFIG_INVALID naming the path when the file is unreadable", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "spo-")), "nope.txt");
    expect(loadSystemPromptOverride(missing)).rejects.toThrow(CleetusError);
    try {
      await loadSystemPromptOverride(missing);
    } catch (e) {
      expect((e as CleetusError).code).toBe("CONFIG_INVALID");
      expect((e as Error).message).toContain(missing);
    }
  });
});

// Source-scan guard (precedent: tests/agent/prompt-stability.test.ts): both entrypoints must
// consult the override in BOTH the standard and small system-prompt closures.
describe("entrypoints consult the override", () => {
  for (const file of ["src/bin/cleetus.ts", "src/acp/runtime.ts"]) {
    it(`${file} applies personaOverride in both closures`, async () => {
      const src = await Bun.file(join(import.meta.dir, "../..", file)).text();
      const hits = src.match(/personaOverride \?\?/g) ?? [];
      expect(hits.length).toBeGreaterThanOrEqual(2);
    });
  }
});
