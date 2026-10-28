import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { resolveConfigRoot } from "../../src/config/config-root";

test("explicit absolute config dir wins", () => {
  expect(resolveConfigRoot("/app/cfg", "/home/u", "/cwd")).toBe("/app/cfg");
});

test("relative config dir resolves against cwd", () => {
  expect(resolveConfigRoot("cfg", "/home/u", "/cwd")).toBe(resolve("/cwd", "cfg"));
});

test("absent config dir defaults to ~/.config/cleetus", () => {
  expect(resolveConfigRoot(undefined, "/home/u", "/cwd", { platform: "linux", env: {} })).toBe(
    join("/home/u", ".config", "cleetus"),
  );
  expect(resolveConfigRoot("  ", "/home/u", "/cwd", { platform: "linux", env: {} })).toBe(
    join("/home/u", ".config", "cleetus"),
  );
});
