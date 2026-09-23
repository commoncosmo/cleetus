import { sep } from "node:path";
import type { ToolAuthorization } from "../tools/types";
import {
  BUILTIN_DEFAULTS,
  type Decision,
  PATH_READING_TOOLS,
  PATH_WRITING_TOOLS,
  type PermissionRule,
  type PermissionRules,
} from "./types";

export function toolMatches(rulePattern: string, tool: string): boolean {
  if (rulePattern.endsWith("*")) return tool.startsWith(rulePattern.slice(0, -1));
  return rulePattern === tool;
}

function argsMatches(rule: PermissionRule, args: string): boolean {
  if (rule.argsPattern == null) return true;
  if (rule.argsPattern.endsWith("*")) return args.startsWith(rule.argsPattern.slice(0, -1));
  return args === rule.argsPattern;
}

function valueMatches(pattern: string, value: string): boolean {
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

function hasJobConstraints(rule: PermissionRule): boolean {
  return (
    rule.jobKindPattern !== undefined ||
    rule.jobEffect !== undefined ||
    rule.jobTargetPattern !== undefined ||
    rule.maxTimeoutMs !== undefined ||
    rule.maxOutputBytes !== undefined ||
    rule.maxArtifactBytes !== undefined
  );
}

function jobAuthorizationMatches(
  rule: PermissionRule,
  tool: string,
  authorization?: ToolAuthorization,
): boolean {
  if (!hasJobConstraints(rule)) return true;
  if (tool !== "job_start" || authorization?.type !== "client_job") return false;
  if (rule.jobKindPattern && !valueMatches(rule.jobKindPattern, authorization.kind)) return false;
  if (rule.jobEffect && rule.jobEffect !== authorization.effect) return false;
  if (
    rule.jobTargetPattern &&
    (authorization.target === undefined ||
      !valueMatches(rule.jobTargetPattern, authorization.target))
  ) {
    return false;
  }
  if (rule.maxTimeoutMs !== undefined && authorization.limits.timeoutMs > rule.maxTimeoutMs) {
    return false;
  }
  if (
    rule.maxOutputBytes !== undefined &&
    authorization.limits.maxOutputBytes > rule.maxOutputBytes
  ) {
    return false;
  }
  if (
    rule.maxArtifactBytes !== undefined &&
    authorization.limits.maxArtifactBytes > rule.maxArtifactBytes
  ) {
    return false;
  }
  return true;
}

export function pathUnder(target: string, prefix: string): boolean {
  const p = prefix.endsWith(sep) ? prefix.slice(0, -1) : prefix;
  return target === p || target.startsWith(p + sep);
}

/** Scan the persisted/live rules only. In the first layer with any match, a deny wins; otherwise
 *  the first match decides. Returns null when no rule matches, so callers can decide whether
 *  builtin defaults apply (out-of-project reads must not inherit read_file's default `allow`). */
export function evaluateRules(
  rules: PermissionRules,
  tool: string,
  args: string,
  targetPath?: string,
  authorization?: ToolAuthorization,
): Decision | null {
  for (const layer of [rules.project, rules.global]) {
    // Within a layer: any matching deny wins over any other match ("never" must stick
    // regardless of file order). Otherwise the first match wins, as before. Across layers:
    // a project match short-circuits global — a project allow deliberately overrides a
    // global deny (project-overrides-global; both files are user-authored).
    let first: Decision | null = null;
    for (const rule of layer) {
      let matches = false;
      if (rule.pathPrefix !== undefined) {
        matches =
          targetPath != null &&
          (PATH_WRITING_TOOLS.has(tool) || PATH_READING_TOOLS.has(tool)) &&
          pathUnder(targetPath, rule.pathPrefix);
      } else if (rule.tool !== undefined && toolMatches(rule.tool, tool)) {
        matches = argsMatches(rule, args);
      }
      if (!matches) continue;
      if (!jobAuthorizationMatches(rule, tool, authorization)) continue;
      if (rule.decision === "deny") return "deny";
      if (first === null) first = rule.decision;
    }
    if (first !== null) return first;
  }
  return null;
}

export function evaluatePermission(
  rules: PermissionRules,
  tool: string,
  args: string,
  targetPath?: string,
  authorization?: ToolAuthorization,
): Decision {
  return (
    evaluateRules(rules, tool, args, targetPath, authorization) ?? BUILTIN_DEFAULTS[tool] ?? "ask"
  );
}
