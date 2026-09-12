import type { JsonSchema } from "../types";

const JSON_SCHEMA_KEYWORDS = new Set([
  "$anchor",
  "$comment",
  "$defs",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$ref",
  "$schema",
  "$vocabulary",
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "default",
  "dependentRequired",
  "dependentSchemas",
  "deprecated",
  "description",
  "else",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "items",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "readOnly",
  "required",
  "then",
  "title",
  "type",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
  "writeOnly",
]);

const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_VALUE_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/** Correct lexical whitespace on known JSON Schema keywords without changing semantics. */
export function canonicalizeWorkflowCreatorJsonSchema(schema: JsonSchema): JsonSchema {
  const normalized: JsonSchema = {};
  for (const [rawKey, rawValue] of Object.entries(schema)) {
    const trimmed = rawKey.trim();
    const key =
      trimmed !== rawKey && JSON_SCHEMA_KEYWORDS.has(trimmed) && !Object.hasOwn(schema, trimmed)
        ? trimmed
        : rawKey;
    if (
      SCHEMA_MAP_KEYWORDS.has(key) &&
      rawValue &&
      typeof rawValue === "object" &&
      !Array.isArray(rawValue)
    ) {
      normalized[key] = Object.fromEntries(
        Object.entries(rawValue).map(([name, child]) => [
          name,
          child && typeof child === "object" && !Array.isArray(child)
            ? canonicalizeWorkflowCreatorJsonSchema(child as JsonSchema)
            : child,
        ]),
      );
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(rawValue)) {
      normalized[key] = rawValue.map((child) =>
        child && typeof child === "object" && !Array.isArray(child)
          ? canonicalizeWorkflowCreatorJsonSchema(child as JsonSchema)
          : child,
      );
    } else if (
      SCHEMA_VALUE_KEYWORDS.has(key) &&
      rawValue &&
      typeof rawValue === "object" &&
      !Array.isArray(rawValue)
    ) {
      normalized[key] = canonicalizeWorkflowCreatorJsonSchema(rawValue as JsonSchema);
    } else {
      normalized[key] = rawValue;
    }
  }
  return normalized;
}
