import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPermissions } from "../helpers/trusted-config";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-perm-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadPermissions", () => {
  it("loads rules from project and global files", async () => {
    const global = join(dir, "global-perm.yaml");
    await writeFile(
      global,
      `rules:\n  - tool: bash\n    args_pattern: "ls*"\n    decision: allow\n`,
    );
    const proj = join(dir, "proj");
    await mkdir(join(proj, ".cleetus"), { recursive: true });
    await writeFile(
      join(proj, ".cleetus", "permissions.yaml"),
      `rules:\n  - tool: bash\n    args_pattern: "git status*"\n    decision: allow\n`,
    );
    const rules = await loadPermissions({ globalPath: global, projectDir: proj });
    expect(rules.project.length).toBe(1);
    expect(rules.project[0]!.tool).toBe("bash");
    expect(rules.project[0]!.argsPattern).toBe("git status*");
    expect(rules.global.length).toBe(1);
  });

  it("returns empty layers when files missing", async () => {
    const rules = await loadPermissions({ globalPath: join(dir, "x.yaml"), projectDir: dir });
    expect(rules.project).toEqual([]);
    expect(rules.global).toEqual([]);
  });

  it("loads structured client-job constraints", async () => {
    const global = join(dir, "global-job.yaml");
    await writeFile(
      global,
      `rules:\n  - tool: job_start\n    job_kind: "sast.*"\n    job_effect: read\n    job_target_pattern: "repo:*"\n    max_timeout_ms: 120000\n    max_output_bytes: 20000\n    max_artifact_bytes: 40000\n    decision: allow\n`,
    );
    const rules = await loadPermissions({ globalPath: global, projectDir: dir });
    expect(rules.global[0]).toMatchObject({
      tool: "job_start",
      jobKindPattern: "sast.*",
      jobEffect: "read",
      jobTargetPattern: "repo:*",
      maxTimeoutMs: 120_000,
      maxOutputBytes: 20_000,
      maxArtifactBytes: 40_000,
      decision: "allow",
    });
  });

  it("rejects job constraints attached to another tool", async () => {
    const global = join(dir, "bad-job.yaml");
    await writeFile(
      global,
      "rules:\n  - tool: bash\n    job_effect: active_network\n    decision: deny\n",
    );
    await expect(loadPermissions({ globalPath: global, projectDir: dir })).rejects.toThrow(
      "must be 'job_start'",
    );
  });
});
