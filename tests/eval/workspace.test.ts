import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scenario } from "../../src/eval/scenario";
import { cleanupWorkspace, prepareWorkspace } from "../../src/eval/workspace";

function scenario(fixtureDir: string | null): Scenario {
  return { name: "s", prompt: "p", check: "c", checkTimeoutMs: 1, agentTimeoutMs: 1, fixtureDir };
}

test("copies the fixture into a fresh temp dir", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "cleetus-fx-"));
  mkdirSync(join(fixture, "sub"), { recursive: true });
  writeFileSync(join(fixture, "sub", "a.txt"), "hello");
  const dir = await prepareWorkspace(scenario(fixture));
  expect(readFileSync(join(dir, "sub", "a.txt"), "utf8")).toBe("hello");
  await cleanupWorkspace(dir);
  expect(existsSync(dir)).toBe(false);
  await cleanupWorkspace(fixture);
});

test("empty workdir when no fixture", async () => {
  const dir = await prepareWorkspace(scenario(null));
  expect(existsSync(dir)).toBe(true);
  await cleanupWorkspace(dir);
  expect(existsSync(dir)).toBe(false);
});
