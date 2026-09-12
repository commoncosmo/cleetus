import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scenario } from "./scenario";

/** Make a fresh temp workdir for a run, copying the scenario's fixture in if present. */
export async function prepareWorkspace(scenario: Scenario): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cleetus-eval-"));
  if (scenario.fixtureDir) {
    await cp(scenario.fixtureDir, dir, { recursive: true });
  }
  return dir;
}

/** Remove a workspace created by prepareWorkspace. Best-effort (won't throw if absent). */
export async function cleanupWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
