import { expect, test } from "bun:test";
import { resolveSpecs } from "../../src/config/specs";

test("resolveSpecs defaults to docs/specs", () => {
  expect(resolveSpecs(undefined, undefined)).toEqual({ dir: "docs/specs" });
});

test("resolveSpecs honors a project override over global", () => {
  expect(resolveSpecs({ dir: "g/specs" }, { dir: "p/specs" })).toEqual({ dir: "p/specs" });
});

test("resolveSpecs falls back to global when project is absent", () => {
  expect(resolveSpecs({ dir: "g/specs" }, undefined)).toEqual({ dir: "g/specs" });
});
