import { expect, test } from "bun:test";
import { resolveModelFamily } from "../../src/config/model-family";

test("defaults to enabled with no override", () => {
  expect(resolveModelFamily(undefined, undefined)).toEqual({ enabled: true });
});

test("project overrides global", () => {
  expect(resolveModelFamily({ enabled: true }, { enabled: false })).toEqual({ enabled: false });
});

test("carries an override family", () => {
  expect(resolveModelFamily(undefined, { override: "qwen" })).toEqual({
    enabled: true,
    override: "qwen",
  });
});
