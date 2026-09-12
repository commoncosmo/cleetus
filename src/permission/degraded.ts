import { toolMatches } from "./evaluator";
import type { PermissionRule, PermissionRules } from "./types";

function allowsBash(r: PermissionRule): boolean {
  return r.decision === "allow" && r.tool !== undefined && toolMatches(r.tool, "bash");
}

/**
 * Silently-degraded sandbox posture (audit F2): with no OS boundary behind them, persisted
 * bash allow rules are suspended — every bash command must prompt. A wildcard/prefix allow rule
 * that also matches other tools is not dropped wholesale: it is re-expanded over the registered
 * tool roster minus bash, preserving its other fields, so only bash loses the allow (PR #269
 * Minor). Expansion iterates tool NAMES, never command text — no command parsing here.
 * In-place mutation so the resolver/UI closures that captured the rules object observe the
 * strip. Rules granted live during the session re-enter via addRule and apply until exit; they
 * persist to disk but are stripped again on the next degraded launch. Deny/ask rules and
 * non-bash rules pass through. Explicit `backend: "none"` (degraded=false) never reaches this.
 */
export function stripBashAllowRules(rules: PermissionRules, toolNames: readonly string[]): void {
  const expand = (r: PermissionRule): PermissionRule[] => {
    if (!allowsBash(r)) return [r];
    return toolNames
      .filter((name) => name !== "bash" && toolMatches(r.tool!, name))
      .map((name) => ({ ...r, tool: name }));
  };
  rules.project = rules.project.flatMap(expand);
  rules.global = rules.global.flatMap(expand);
}
