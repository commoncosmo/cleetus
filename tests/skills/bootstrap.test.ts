import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapSkills } from "../../src/skills/bootstrap";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function globalWithSkill(): string {
  const globalDir = tmp("cleetus-boot-");
  mkdirSync(join(globalDir, "skills"), { recursive: true });
  writeFileSync(join(globalDir, "skills", "foo.md"), "---\nname: foo\ndescription: d\n---\nbody");
  return globalDir;
}

describe("bootstrapSkills", () => {
  it("discovers skills and builds a hint when enabled", async () => {
    const globalDir = globalWithSkill();
    const { registry, hint } = await bootstrapSkills({
      startDir: tmp("cleetus-boot-start-"),
      globalDir,
      enabled: true,
    });
    expect(registry.get("foo")).toBeDefined();
    expect(hint).toContain("foo");
  });

  it("skips discovery and emits an empty hint when disabled (built-ins still present)", async () => {
    const globalDir = globalWithSkill();
    const { registry, hint } = await bootstrapSkills({
      startDir: tmp("cleetus-boot-start2-"),
      globalDir,
      enabled: false,
    });
    expect(registry.get("foo")).toBeUndefined();
    expect(registry.get("security-scan")).toBeDefined(); // built-in still available
    expect(hint).toBe("");
  });

  it("populates the registry but suppresses the hint when suppressHint is set", async () => {
    const globalDir = globalWithSkill();
    const { registry, hint } = await bootstrapSkills({
      startDir: tmp("cleetus-boot-start3-"),
      globalDir,
      enabled: true,
      suppressHint: true,
    });
    expect(registry.get("foo")).toBeDefined();
    expect(hint).toBe("");
  });
});
