import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { persistRule } from "../../src/permission/persist";
import { loadPermissions } from "../helpers/trusted-config";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-persist-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("persistRule", () => {
  it("appends rule to project permissions.yaml, creating it if missing", async () => {
    const filePath = join(dir, ".cleetus", "permissions.yaml");
    await persistRule(filePath, { tool: "bash", argsPattern: "git status*", decision: "allow" });
    const text = await readFile(filePath, "utf8");
    expect(text).toContain("tool: bash");
    expect(text).toContain("git status*");
    expect(text).toContain("allow");
  });

  it("appends to existing rules", async () => {
    const filePath = join(dir, ".cleetus", "permissions.yaml");
    await persistRule(filePath, { tool: "bash", argsPattern: "ls*", decision: "allow" });
    await persistRule(filePath, { tool: "bash", argsPattern: "pwd*", decision: "allow" });
    const text = await readFile(filePath, "utf8");
    expect(text).toContain("ls*");
    expect(text).toContain("pwd*");
  });
});

describe("persistRule with a deny decision", () => {
  it("persists a deny rule that a fresh load returns with decision deny", async () => {
    const file = join(dir, "permissions.yaml");
    await persistRule(file, { tool: "bash", argsPattern: "rm -rf*", decision: "deny" });
    const text = await readFile(file, "utf8");
    expect(text).toContain("decision: deny");
    expect(text).toContain("args_pattern: rm -rf*");
  });
});

describe("persistRule de-dup", () => {
  it("does not write a duplicate identical rule", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-persist-"));
    const file = join(dir, "permissions.yaml");
    await persistRule(file, { tool: "write_file", decision: "allow" });
    await persistRule(file, { tool: "write_file", decision: "allow" });
    const parsed = parseYaml(await readFile(file, "utf8")) as { rules: unknown[] };
    expect(parsed.rules).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("persistRule + loadPermissions round-trip", () => {
  it("round-trips a pathPrefix rule", async () => {
    const globalFile = join(dir, "global.yaml");
    const projDir = await mkdtemp(join(tmpdir(), "cleetus-rt-proj-"));
    await mkdir(join(projDir, ".cleetus"), { recursive: true });
    try {
      await persistRule(globalFile, { pathPrefix: "/proj/src", decision: "allow" });
      const rules = await loadPermissions({ globalPath: globalFile, projectDir: projDir });
      expect(rules.global).toHaveLength(1);
      expect(rules.global[0]).toEqual({
        tool: undefined,
        argsPattern: undefined,
        pathPrefix: "/proj/src",
        decision: "allow",
      });
    } finally {
      await rm(projDir, { recursive: true, force: true });
    }
  });

  it("round-trips a tool+argsPattern rule", async () => {
    const globalFile = join(dir, "global2.yaml");
    const projDir = await mkdtemp(join(tmpdir(), "cleetus-rt-proj2-"));
    await mkdir(join(projDir, ".cleetus"), { recursive: true });
    try {
      await persistRule(globalFile, { tool: "bash", argsPattern: "git push*", decision: "allow" });
      const rules = await loadPermissions({ globalPath: globalFile, projectDir: projDir });
      expect(rules.global).toHaveLength(1);
      expect(rules.global[0]).toEqual({
        tool: "bash",
        argsPattern: "git push*",
        pathPrefix: undefined,
        decision: "allow",
      });
    } finally {
      await rm(projDir, { recursive: true, force: true });
    }
  });

  it("round-trips structured client-job constraints", async () => {
    const globalFile = join(dir, "global-job.yaml");
    const projDir = await mkdtemp(join(tmpdir(), "cleetus-rt-job-"));
    await mkdir(join(projDir, ".cleetus"), { recursive: true });
    try {
      await persistRule(globalFile, {
        tool: "job_start",
        jobKindPattern: "dast.*",
        jobEffect: "active_network",
        jobTargetPattern: "https://staging.*",
        maxTimeoutMs: 300_000,
        maxOutputBytes: 50_000,
        maxArtifactBytes: 100_000,
        decision: "deny",
      });
      const rules = await loadPermissions({ globalPath: globalFile, projectDir: projDir });
      expect(rules.global[0]).toMatchObject({
        tool: "job_start",
        jobKindPattern: "dast.*",
        jobEffect: "active_network",
        jobTargetPattern: "https://staging.*",
        maxTimeoutMs: 300_000,
        maxOutputBytes: 50_000,
        maxArtifactBytes: 100_000,
        decision: "deny",
      });
    } finally {
      await rm(projDir, { recursive: true, force: true });
    }
  });
});
