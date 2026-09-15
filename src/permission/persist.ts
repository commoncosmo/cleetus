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
  const duplicate = existing.rules.some(
    (r) =>
      r != null &&
      typeof r === "object" &&
      (r as Record<string, unknown>).tool === yamlRule.tool &&
      (r as Record<string, unknown>).decision === yamlRule.decision &&
      (r as Record<string, unknown>).args_pattern === yamlRule.args_pattern &&
      (r as Record<string, unknown>).path_prefix === yamlRule.path_prefix,
  );
  if (!duplicate) existing.rules.push(yamlRule);
  writePrivateFile(filePath, stringifyYaml(existing));
}
