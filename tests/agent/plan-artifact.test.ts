import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistPlanArtifact } from "../../src/agent/plan-artifact";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-plan-artifact-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("persists a plan only beneath the host-managed .cleetus/plans directory", async () => {
  const relative = await persistPlanArtifact({
    projectDir: dir,
    sessionId: "session/unsafe",
    plan: "Implementation plan:\n1. inspect\n2. implement",
    now: 123,
  });
  expect(relative).toBe(".cleetus/plans/session-unsafe-123.md");
  expect(await readFile(join(dir, relative), "utf8")).toBe(
    "Implementation plan:\n1. inspect\n2. implement\n",
  );
});
