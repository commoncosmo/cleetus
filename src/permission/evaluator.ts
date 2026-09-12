import { sep } from "node:path";
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

export function pathUnder(target: string, prefix: string): boolean {
  const p = prefix.endsWith(sep) ? prefix.slice(0, -1) : prefix;
  return target === p || target.startsWith(p + sep);
}

/** Scan the persisted/live rules only. Returns the first matching rule's decision, or null when
 *  NO rule matches — callers decide whether builtin defaults apply (out-of-project reads must
 *  not inherit read_file's default `allow`). */
export function evaluateRules(
  rules: PermissionRules,
  tool: string,
  args: string,
  targetPath?: string,
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
): Decision {
  return evaluateRules(rules, tool, args, targetPath) ?? BUILTIN_DEFAULTS[tool] ?? "ask";
}
