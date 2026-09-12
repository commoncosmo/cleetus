import type { Decision, PermissionRule, PermissionRules } from "./types";

/** Append an in-memory rule so the running session honors a just-granted (or just-denied)
 *  permission immediately. Deduped on the full shape (tool/argsPattern/pathPrefix/decision). */
export function addRule(
  rules: PermissionRules,
  scope: "project" | "global",
  partial: Omit<PermissionRule, "decision">,
  decision: Decision = "allow",
): void {
  const layer = scope === "project" ? rules.project : rules.global;
  const exists = layer.some(
    (r) =>
      r.decision === decision &&
      r.tool === partial.tool &&
      r.argsPattern === partial.argsPattern &&
      r.pathPrefix === partial.pathPrefix,
  );
  if (exists) return;
  layer.push({ ...partial, decision });
}

/** Tool-level allow (no args/path narrowing) — the existing prompt's allow-project/global. */
export function addAllowRule(
  rules: PermissionRules,
  scope: "project" | "global",
  tool: string,
): void {
  addRule(rules, scope, { tool });
}
