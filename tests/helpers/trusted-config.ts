import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoadConfigOptions, loadConfig as originalLoadConfig } from "../../src/config/loader";
import {
  type LoadPermissionsOptions,
  loadPermissions as originalLoadPermissions,
  makeRulesForCwd as originalMakeRulesForCwd,
} from "../../src/permission/loader";
import { approveProjectConfiguration } from "../../src/security/project-trust";

// Existing merge/validation tests deliberately exercise approved configuration.
// Untrusted and invalidation behavior is covered separately in project-trust.test.ts.
const trustStoreDir = mkdtempSync(join(tmpdir(), "cleetus-test-trust-"));
export async function loadConfig(opts: LoadConfigOptions) {
  const trusted = { ...opts, trustStoreDir };
  await approveProjectConfiguration(trusted);
  return originalLoadConfig(trusted);
}
export async function loadPermissions(opts: LoadPermissionsOptions) {
  const trusted = { ...opts, trustStoreDir };
  await approveProjectConfiguration(trusted);
  return originalLoadPermissions(trusted);
}

export function makeRulesForCwd(globalPath: string) {
  const loader = originalMakeRulesForCwd(globalPath);
  return async (projectDir: string) => {
    await approveProjectConfiguration({ globalPath, projectDir });
    return loader(projectDir);
  };
}
