import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenarios } from "../../src/eval/scenario";

function scenariosRoot(): string {
  return mkdtempSync(join(tmpdir(), "cleetus-scn-"));
}

test("loads a scenario with defaults and a fixture dir", () => {
  const root = scenariosRoot();
  mkdirSync(join(root, "fix-bug", "fixture"), { recursive: true });
  writeFileSync(join(root, "fix-bug", "scenario.yaml"), "prompt: do the thing\ncheck: bun test\n");
  const scenarios = loadScenarios(root);
  expect(scenarios).toHaveLength(1);
  const s = scenarios[0]!;
  expect(s.name).toBe("fix-bug");
  expect(s.prompt).toBe("do the thing");
  expect(s.check).toBe("bun test");
  expect(s.checkTimeoutMs).toBe(60_000);
  expect(s.agentTimeoutMs).toBe(300_000);
  expect(s.fixtureDir).toBe(join(root, "fix-bug", "fixture"));
});

test("fixtureDir is null when no fixture/ dir exists; custom timeouts honored", () => {
  const root = scenariosRoot();
  mkdirSync(join(root, "quick"), { recursive: true });
  writeFileSync(
    join(root, "quick", "scenario.yaml"),
    "prompt: p\ncheck: c\ncheck_timeout_ms: 5000\nagent_timeout_ms: 9000\n",
  );
  const s = loadScenarios(root)[0]!;
  expect(s.fixtureDir).toBeNull();
  expect(s.checkTimeoutMs).toBe(5000);
  expect(s.agentTimeoutMs).toBe(9000);
});

test("throws on a manifest missing prompt or check", () => {
  const root = scenariosRoot();
  mkdirSync(join(root, "bad"), { recursive: true });
  writeFileSync(join(root, "bad", "scenario.yaml"), "prompt: only\n");
  expect(() => loadScenarios(root)).toThrow(/check/);
});

test("returns [] when the scenarios dir does not exist", () => {
  expect(loadScenarios(join(tmpdir(), `cleetus-no-such-scn-${process.pid}-${Date.now()}`))).toEqual(
    [],
  );
});

test("throws on an empty/null scenario.yaml", () => {
  const root = scenariosRoot();
  mkdirSync(join(root, "empty"), { recursive: true });
  writeFileSync(join(root, "empty", "scenario.yaml"), "");
  expect(() => loadScenarios(root)).toThrow(/prompt/);
});
