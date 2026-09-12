import { expect, test } from "bun:test";
import { resolveFormat } from "../../src/config/format";

test("resolveFormat defaults to enabled", () => {
  expect(resolveFormat(undefined, undefined)).toEqual({ enabled: true });
});

test("resolveFormat honors project over global", () => {
  expect(resolveFormat({ enabled: true }, { enabled: false })).toEqual({ enabled: false });
});

test("resolveFormat falls back to global when project is absent", () => {
  expect(resolveFormat({ enabled: false }, undefined)).toEqual({ enabled: false });
});
