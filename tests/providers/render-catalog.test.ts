import { expect, test } from "bun:test";
import { type Catalog, formatCatalog, renderCatalog } from "../../src/providers/catalog";

const catalog: Catalog = [
  { provider: "ollama", models: ["qwen3.6", "llama3"] },
  { provider: "lmstudio", models: [], error: "connect ECONNREFUSED" },
];

test("renderCatalog json emits the catalog as parseable JSON including the error field", () => {
  expect(JSON.parse(renderCatalog(catalog, { json: true }))).toEqual(catalog);
});

test("renderCatalog non-json matches the human-readable text format", () => {
  expect(renderCatalog(catalog, { json: false })).toBe(formatCatalog(catalog));
});
