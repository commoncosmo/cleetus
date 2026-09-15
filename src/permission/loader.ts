import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CleetusError } from "../lib/errors";
import { readTrustedProjectFile } from "../security/project-trust";
import type { PermissionRule, PermissionRules } from "./types";

const RuleSchema = z.object({
  tool: z.string().optional(),
  args_pattern: z.string().optional(),
  path_prefix: z.string().optional(),
  decision: z.enum(["allow", "deny", "ask"]),
});

const FileSchema = z.object({
  rules: z.array(RuleSchema).default([]),
});

async function readRules(path: string, approvedText?: string | null): Promise<PermissionRule[]> {
  if (approvedText === null) return [];
  let text: string;
  try {
    text = approvedText ?? (await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CleetusError("IO_FAILED", `failed to read ${path}`, { cause: e });
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new CleetusError(
      "PERMISSION_INVALID",
      `invalid YAML in ${path}: ${(e as Error).message}`,
    );
  }
  const parsed = FileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new CleetusError(
      "PERMISSION_INVALID",
      `invalid permissions in ${path}: ${parsed.error.message}`,
    );
  }
  return parsed.data.rules.map((r) => ({
    tool: r.tool,
    argsPattern: r.args_pattern,
    pathPrefix: r.path_prefix,
    decision: r.decision,
  }));
}

export interface LoadPermissionsOptions {
  globalPath: string;
  projectDir: string;
  trustStoreDir?: string;
}

export async function loadPermissions(opts: LoadPermissionsOptions): Promise<PermissionRules> {
  const [project, global] = await Promise.all([
    readRules(
      join(opts.projectDir, ".cleetus", "permissions.yaml"),
      await readTrustedProjectFile(opts, "permissions.yaml"),
    ),
    readRules(opts.globalPath),
  ]);
  return { project, global };
}

/** Per-cwd rule loader for surfaces whose sessions carry their own cwd (ACP): the project layer
 *  loads from each session's cwd — the SAME `.cleetus/permissions.yaml` `persistRule` writes to
 *  (PR #266-#269 Minor: persist-path vs load-path cwd asymmetry). Cached per cwd (read once; no
 *  per-turn reads). A failed load is evicted so a fixed permissions.yaml is picked up on the
 *  next prompt instead of caching the rejection forever. */
export function makeRulesForCwd(globalPath: string): (cwd: string) => Promise<PermissionRules> {
  const cache = new Map<string, Promise<PermissionRules>>();
  return (cwd) => {
    let pending = cache.get(cwd);
    if (pending == null) {
      pending = loadPermissions({ globalPath, projectDir: cwd });
      pending.catch(() => cache.delete(cwd));
      cache.set(cwd, pending);
    }
    return pending;
  };
}
