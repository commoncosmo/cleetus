import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPermissions } from "../../../src/permission/loader";
import { persistRule } from "../../../src/permission/persist";
import {
  type PermissionAction,
  editedPermissionGrant,
} from "../../../src/ui/tui/permission-prompt";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function grant(action: PermissionAction | null) {
  expect(action).not.toBeNull();
  expect(typeof action).toBe("object");
  if (!action || typeof action !== "object" || action.kind !== "grant") {
    throw new Error("expected a persisted permission grant action");
  }
  return action;
}

describe("never-allow permission flow", () => {
  test("Enter's project action builds a directory-scoped deny rule", () => {
    expect(editedPermissionGrant("read_file", "/outside/private", "deny", "project")).toEqual({
      kind: "grant",
      rule: { pathPrefix: "/outside/private" },
      scope: "project",
      decision: "deny",
    });
  });

  test("the global action preserves global scope", () => {
    expect(editedPermissionGrant("bash", "curl secrets", "deny", "global")).toEqual({
      kind: "grant",
      rule: { tool: "bash", argsPattern: "curl secrets*" },
      scope: "global",
      decision: "deny",
    });
  });

  test("the project deny action round-trips through the permissions file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-never-permission-"));
    dirs.push(dir);
    const projectFile = join(dir, ".cleetus", "permissions.yaml");
    const globalFile = join(dir, "global-permissions.yaml");
    await mkdir(join(dir, ".cleetus"), { recursive: true });
    const action = grant(editedPermissionGrant("read_file", "/outside/private", "deny", "project"));

    const path = action.scope === "project" ? projectFile : globalFile;
    await persistRule(path, { ...action.rule, decision: action.decision });

    expect(await readFile(projectFile, "utf8")).toContain("decision: deny");
    expect(await loadPermissions({ projectDir: dir, globalPath: globalFile })).toEqual({
      project: [
        {
          tool: undefined,
          argsPattern: undefined,
          pathPrefix: "/outside/private",
          decision: "deny",
        },
      ],
      global: [],
    });
  });
});
