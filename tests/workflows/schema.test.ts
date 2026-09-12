import { describe, expect, it } from "bun:test";
import { WorkflowSchemaService } from "../../src/workflows/schema";

const schemas = new WorkflowSchemaService();

describe("WorkflowSchemaService", () => {
  it("validates structured values and reports stable paths", () => {
    const schema = schemas.compile({
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: { type: "array", minItems: 2, items: { type: "string" } },
      },
    });
    expect(schema.validate({ items: ["a", "b"] })).toEqual([]);
    expect(schema.validate({ items: ["a"] })).toEqual([
      { path: "/items", message: "must NOT have fewer than 2 items", keyword: "minItems" },
    ]);
  });

  it("does not coerce or mutate values", () => {
    const value: Record<string, unknown> = { count: "3" };
    const schema = schemas.compile({
      type: "object",
      properties: { count: { type: "integer", default: 3 } },
    });
    expect(schema.validate(value)[0]?.keyword).toBe("type");
    expect(value).toEqual({ count: "3" });
  });

  it("rejects additional properties when the schema requests it", () => {
    const schema = schemas.compile({
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
    });
    expect(schema.validate({ ok: true, extra: 1 })[0]).toMatchObject({
      path: "/",
      keyword: "additionalProperties",
    });
  });

  it("rejects remote refs and invalid schemas", () => {
    expect(() => schemas.compile({ $ref: "https://example.com/schema.json" })).toThrow(
      "unsupported remote $ref",
    );
    expect(() => schemas.compile({ type: "definitely-not-json-schema" })).toThrow("is invalid");
  });
});
