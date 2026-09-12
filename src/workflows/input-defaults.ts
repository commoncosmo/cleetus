import type { JsonObject, JsonSchema, JsonValue } from "./types";

const NO_DEFAULT = Symbol("no workflow input default");

export function schemaCanProduceDefault(schema: JsonSchema): boolean {
  if (Object.hasOwn(schema, "default")) return true;
  if (schema.type !== "object" && !schema.properties) return false;
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, JsonSchema>)
      : {};
  return Object.values(properties).some(schemaCanProduceDefault);
}

function valueWithSchemaDefaults(
  schema: JsonSchema,
  supplied: JsonValue | undefined,
  present: boolean,
): JsonValue | typeof NO_DEFAULT {
  let value = supplied;
  if (!present) {
    if (Object.hasOwn(schema, "default")) {
      value = structuredClone(schema.default as JsonValue);
    } else if (schemaCanProduceDefault(schema)) {
      value = {};
    } else {
      return NO_DEFAULT;
    }
  }
  if (Array.isArray(value)) {
    const itemSchema =
      schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)
        ? (schema.items as JsonSchema)
        : undefined;
    return itemSchema
      ? value.map((item) => {
          const selected = valueWithSchemaDefaults(itemSchema, item, true);
          return selected === NO_DEFAULT ? item : selected;
        })
      : value;
  }
  if (!value || typeof value !== "object") return value!;
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, JsonSchema>)
      : {};
  const output: JsonObject = { ...(value as JsonObject) };
  for (const [name, property] of Object.entries(properties)) {
    const selected = valueWithSchemaDefaults(property, output[name], Object.hasOwn(output, name));
    if (selected !== NO_DEFAULT) output[name] = selected;
  }
  return output;
}

export function applyWorkflowInputDefaults(schema: JsonSchema, supplied: JsonObject): JsonObject {
  const selected = valueWithSchemaDefaults(schema, supplied, true);
  return selected === NO_DEFAULT ? supplied : (selected as JsonObject);
}
