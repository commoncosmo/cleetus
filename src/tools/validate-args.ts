import type { Tool } from "./types";

/** snake_case → camelCase (e.g. "old_text" → "oldText"). */
function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Validate a tool call's TOP-LEVEL required arguments against the tool's `parameters` JSON
 * schema. Returns an actionable error message, or null when valid. Never throws.
 *
 * - Each `required` field must be present (alias-aware: snake_case OR its camelCase spelling).
 * - A required field whose schema type is "string" must be a non-empty string.
 * - Other declared types are checked for presence only (no deep validation).
 */
export function validateToolArgs(tool: Tool, args: unknown): string | null {
  const schema = tool.parameters as {
    required?: string[];
    properties?: Record<string, { type?: string }>;
  };
  const required = schema.required ?? [];
  if (required.length === 0) return null;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return `${tool.name}: expected an arguments object`;
  }
  const obj = args as Record<string, unknown>;
  for (const field of required) {
    const value = obj[field] ?? obj[toCamel(field)];
    const type = schema.properties?.[field]?.type;
    if (value === undefined || value === null) {
      return `${tool.name}: missing required parameter '${field}'${type ? ` (${type})` : ""}`;
    }
    if (type === "string" && (typeof value !== "string" || value.length === 0)) {
      return `${tool.name}: parameter '${field}' must be a non-empty string`;
    }
  }
  return null;
}
