import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/loader";
import { scaffoldConfig, writeDetectedConfig } from "../../src/setup/first-run";

test("writeDetectedConfig writes a config that round-trips through loadConfig", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "cleetus-wd-"));
  const projectDir = mkdtempSync(join(tmpdir(), "cleetus-wd-proj-"));
  const path = writeDetectedConfig(globalDir, [
    { type: "lmstudio", baseUrl: "http://localhost:1234", models: ["m1", "m2"] },
  ]);
  expect(path).toBe(join(globalDir, "config.yaml"));
  const config = await loadConfig({ globalPath: join(globalDir, "config.yaml"), projectDir });
  expect(config.providers.lmstudio?.type).toBe("lmstudio");
  expect(config.providers.lmstudio?.baseUrl).toBe("http://localhost:1234");
  expect(config.defaultProvider).toBe("lmstudio");
  expect(config.defaultModel).toBe("m1");
});

test("writeDetectedConfig does not overwrite an existing config.yaml", () => {
  const globalDir = mkdtempSync(join(tmpdir(), "cleetus-wd2-"));
  writeFileSync(join(globalDir, "config.yaml"), "existing");
  const path = writeDetectedConfig(globalDir, [
    { type: "ollama", baseUrl: "http://localhost:11434", models: ["x"] },
  ]);
  expect(path).toBeNull();
  expect(readFileSync(join(globalDir, "config.yaml"), "utf8")).toBe("existing");
});

test("writeDetectedConfig returns null and writes nothing for an empty detection", () => {
  const globalDir = mkdtempSync(join(tmpdir(), "cleetus-wd3-"));
  const path = writeDetectedConfig(globalDir, []);
  expect(path).toBeNull();
  expect(existsSync(join(globalDir, "config.yaml"))).toBe(false);
});

test("scaffoldConfig writes a parseable template + instructions, never overwriting", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "cleetus-sc-"));
  const projectDir = mkdtempSync(join(tmpdir(), "cleetus-sc-proj-"));
  const path = scaffoldConfig(globalDir);
  expect(path).toBe(join(globalDir, "config.yaml"));
  expect(existsSync(join(globalDir, "instructions.md"))).toBe(true);
  const config = await loadConfig({ globalPath: path, projectDir });
  expect(config.providers).toEqual({}); // commented template → zero providers
  const template = readFileSync(path, "utf8");
  expect(template).toContain("base_url: http://localhost:1234\n");
  expect(template).toContain("base_url: http://localhost:11434\n");
  expect(template).toContain("base_url: http://localhost:8080\n");
  expect(template).not.toContain("localhost:1234/v1");
  expect(template).not.toContain("localhost:11434/v1");
  expect(template).not.toContain("localhost:8080/v1");
  writeFileSync(path, "custom");
  scaffoldConfig(globalDir);
  expect(readFileSync(path, "utf8")).toBe("custom"); // not overwritten
});
