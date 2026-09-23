import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CleetusError } from "../lib/errors";
import { writePrivateFile } from "../security/private-state";
import type { PermissionRule } from "./types";

// NOTE: read-modify-write is not atomic. Safe for Phase 0 (single-process app);
// will need locking when multiple agents share a project (Phase 5).
export async function persistRule(filePath: string, rule: PermissionRule): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  let existing: { rules: unknown[] } = { rules: [] };
  try {
    const text = await readFile(filePath, "utf8");
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
  if (rule.pathPrefix !== undefined) yamlRule.path_prefix = rule.pathPrefix;
  if (rule.jobKindPattern !== undefined) yamlRule.job_kind = rule.jobKindPattern;
  if (rule.jobEffect !== undefined) yamlRule.job_effect = rule.jobEffect;
  if (rule.jobTargetPattern !== undefined) yamlRule.job_target_pattern = rule.jobTargetPattern;
  if (rule.maxTimeoutMs !== undefined) yamlRule.max_timeout_ms = rule.maxTimeoutMs;
  if (rule.maxOutputBytes !== undefined) yamlRule.max_output_bytes = rule.maxOutputBytes;
  if (rule.maxArtifactBytes !== undefined) yamlRule.max_artifact_bytes = rule.maxArtifactBytes;
  const duplicate = existing.rules.some(
    (r) =>
      r != null &&
      typeof r === "object" &&
      (r as Record<string, unknown>).tool === yamlRule.tool &&
      (r as Record<string, unknown>).decision === yamlRule.decision &&
      (r as Record<string, unknown>).args_pattern === yamlRule.args_pattern &&
      (r as Record<string, unknown>).path_prefix === yamlRule.path_prefix &&
      (r as Record<string, unknown>).job_kind === yamlRule.job_kind &&
      (r as Record<string, unknown>).job_effect === yamlRule.job_effect &&
      (r as Record<string, unknown>).job_target_pattern === yamlRule.job_target_pattern &&
      (r as Record<string, unknown>).max_timeout_ms === yamlRule.max_timeout_ms &&
      (r as Record<string, unknown>).max_output_bytes === yamlRule.max_output_bytes &&
      (r as Record<string, unknown>).max_artifact_bytes === yamlRule.max_artifact_bytes,
  );
  if (!duplicate) existing.rules.push(yamlRule);
  writePrivateFile(filePath, stringifyYaml(existing));
}
