import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CleetusError } from "../lib/errors";
import { comparablePath } from "../lib/paths";
import { type ProjectTrustOptions, readTrustedProjectFile } from "../security/project-trust";
import { validCommandPattern } from "./command-pattern";
import { realpathWithMissingParents } from "./path-guard";
import type { PermissionRule, PermissionRules } from "./types";

const RuleSchema = z
  .object({
    tool: z.string().optional(),
    args_pattern: z.string().optional(),
    command_pattern: z
      .string()
      .refine(validCommandPattern, "unsupported command pattern")
      .optional(),
    command_cwd: z.string().refine(isAbsolute, "command cwd must be absolute").optional(),
    command_shell: z.string().min(1).optional(),
    path_prefix: z.string().optional(),
    job_kind: z.string().min(1).optional(),
    job_effect: z.enum(["read", "passive_network", "active_network", "write"]).optional(),
    job_target_pattern: z.string().min(1).optional(),
    max_timeout_ms: z.number().int().nonnegative().optional(),
    max_output_bytes: z.number().int().nonnegative().optional(),
    max_artifact_bytes: z.number().int().nonnegative().optional(),
    decision: z.enum(["allow", "deny", "ask"]),
  })
  .superRefine((rule, ctx) => {
    if (
      rule.command_pattern !== undefined ||
      rule.command_cwd !== undefined ||
      rule.command_shell !== undefined
    ) {
      if (
        rule.tool !== "bash" ||
        !rule.command_pattern ||
        !rule.command_cwd ||
        !rule.command_shell ||
        rule.args_pattern !== undefined ||
        rule.path_prefix !== undefined ||
        rule.job_kind !== undefined ||
        rule.job_effect !== undefined ||
        rule.job_target_pattern !== undefined ||
        rule.max_timeout_ms !== undefined ||
        rule.max_output_bytes !== undefined ||
        rule.max_artifact_bytes !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "command rules require bash, command_pattern, command_cwd and command_shell without other constraints",
        });
      }
    }
    const hasJobConstraint =
      rule.job_kind !== undefined ||
      rule.job_effect !== undefined ||
      rule.job_target_pattern !== undefined ||
      rule.max_timeout_ms !== undefined ||
      rule.max_output_bytes !== undefined ||
      rule.max_artifact_bytes !== undefined;
    if (hasJobConstraint && rule.tool !== "job_start") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tool"],
        message: "must be 'job_start' when job authorization constraints are present",
      });
    }
    if (hasJobConstraint && rule.path_prefix !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path_prefix"],
        message: "cannot be combined with job authorization constraints",
      });
    }
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
    ...(r.command_pattern !== undefined
      ? {
          commandPattern: r.command_pattern,
          commandCwd: r.command_cwd,
          commandShell: r.command_shell,
        }
      : {}),
    pathPrefix: r.path_prefix,
    ...(r.job_kind !== undefined ? { jobKindPattern: r.job_kind } : {}),
    ...(r.job_effect !== undefined ? { jobEffect: r.job_effect } : {}),
    ...(r.job_target_pattern !== undefined ? { jobTargetPattern: r.job_target_pattern } : {}),
    ...(r.max_timeout_ms !== undefined ? { maxTimeoutMs: r.max_timeout_ms } : {}),
    ...(r.max_output_bytes !== undefined ? { maxOutputBytes: r.max_output_bytes } : {}),
    ...(r.max_artifact_bytes !== undefined ? { maxArtifactBytes: r.max_artifact_bytes } : {}),
    decision: r.decision,
  }));
}

export interface LoadPermissionsOptions extends ProjectTrustOptions {}

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
export function makeRulesForCwd(
  globalPath: string,
  globalWorkspaceDir?: string,
): (cwd: string) => Promise<PermissionRules> {
  const cache = new Map<string, Promise<PermissionRules>>();
  // All live sessions share global mutations, including revocation of a saved approval.
  let globalRules: PermissionRule[] | undefined;
  return async (cwd) => {
    const canonical = await realpathWithMissingParents(cwd);
    const key = comparablePath(canonical);
    const workspaceKey = globalWorkspaceDir
      ? comparablePath(await realpathWithMissingParents(globalWorkspaceDir))
      : undefined;
    let pending = cache.get(key);
    if (pending == null) {
      pending = loadPermissions({
        globalPath,
        projectDir: canonical,
        trustGlobalWorkspace: key === workspaceKey,
      }).then((rules) => {
        if (!globalRules) globalRules = rules.global;
        return { project: rules.project, global: globalRules };
      });
      pending.catch(() => cache.delete(key));
      cache.set(key, pending);
    }
    return pending;
  };
}
