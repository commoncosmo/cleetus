import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CleetusError } from "../lib/errors";
import { writePrivateFile } from "../security/private-state";
import {
  type ProjectTrustOptions,
  approveSavedProjectPermissions,
  readTrustedProjectFile,
} from "../security/project-trust";
import type { PermissionRule } from "./types";

// NOTE: read-modify-write is not atomic. Safe for Phase 0 (single-process app);
// will need locking when multiple agents share a project (Phase 5).
export async function persistRule(
  filePath: string,
  rule: PermissionRule,
  projectTrust?: ProjectTrustOptions,
  operation: "add" | "remove" = "add",
): Promise<void> {
  if (
    projectTrust &&
    resolve(filePath) !== resolve(projectTrust.projectDir, ".cleetus", "permissions.yaml")
  ) {
    throw new Error("Saved project approval must target the project's permissions file.");
  }
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  let existing: { rules: unknown[] } = { rules: [] };
  try {
    const text = projectTrust
      ? ((await readTrustedProjectFile(projectTrust, "permissions.yaml")) ?? "")
      : await readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = parseYaml(text) ?? {};
    } catch (e) {
      throw new CleetusError(
        "PERMISSION_INVALID",
        `invalid YAML in ${filePath}: ${(e as Error).message}`,
      );
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { rules?: unknown }).rules)
    ) {
      existing = parsed as { rules: unknown[] };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const yamlRule: Record<string, unknown> = { decision: rule.decision };
  if (rule.tool !== undefined) yamlRule.tool = rule.tool;
  if (rule.argsPattern !== undefined) yamlRule.args_pattern = rule.argsPattern;
  if (rule.commandPattern !== undefined) yamlRule.command_pattern = rule.commandPattern;
  if (rule.commandCwd !== undefined) yamlRule.command_cwd = rule.commandCwd;
  if (rule.commandShell !== undefined) yamlRule.command_shell = rule.commandShell;
  if (rule.pathPrefix !== undefined) yamlRule.path_prefix = rule.pathPrefix;
  if (rule.jobKindPattern !== undefined) yamlRule.job_kind = rule.jobKindPattern;
  if (rule.jobEffect !== undefined) yamlRule.job_effect = rule.jobEffect;
  if (rule.jobTargetPattern !== undefined) yamlRule.job_target_pattern = rule.jobTargetPattern;
  if (rule.maxTimeoutMs !== undefined) yamlRule.max_timeout_ms = rule.maxTimeoutMs;
  if (rule.maxOutputBytes !== undefined) yamlRule.max_output_bytes = rule.maxOutputBytes;
  if (rule.maxArtifactBytes !== undefined) yamlRule.max_artifact_bytes = rule.maxArtifactBytes;
  const matches = (r: unknown) =>
    r != null &&
    typeof r === "object" &&
    (r as Record<string, unknown>).tool === yamlRule.tool &&
    (r as Record<string, unknown>).decision === yamlRule.decision &&
    (r as Record<string, unknown>).args_pattern === yamlRule.args_pattern &&
    (r as Record<string, unknown>).command_pattern === yamlRule.command_pattern &&
    (r as Record<string, unknown>).command_cwd === yamlRule.command_cwd &&
    (r as Record<string, unknown>).command_shell === yamlRule.command_shell &&
    (r as Record<string, unknown>).path_prefix === yamlRule.path_prefix &&
    (r as Record<string, unknown>).job_kind === yamlRule.job_kind &&
    (r as Record<string, unknown>).job_effect === yamlRule.job_effect &&
    (r as Record<string, unknown>).job_target_pattern === yamlRule.job_target_pattern &&
    (r as Record<string, unknown>).max_timeout_ms === yamlRule.max_timeout_ms &&
    (r as Record<string, unknown>).max_output_bytes === yamlRule.max_output_bytes &&
    (r as Record<string, unknown>).max_artifact_bytes === yamlRule.max_artifact_bytes;
  if (operation === "remove") existing.rules = existing.rules.filter((rule) => !matches(rule));
  else if (!existing.rules.some(matches)) existing.rules.push(yamlRule);
  const text = stringifyYaml(existing);
  writePrivateFile(filePath, text);
  if (projectTrust) await approveSavedProjectPermissions(projectTrust, text);
}
