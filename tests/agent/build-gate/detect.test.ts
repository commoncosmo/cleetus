import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBuildCommand } from "../../../src/agent/build-gate/detect";

const dirs: string[] = [];
function tmp(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "cleetus-bg-"));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const pkgWithBuild = JSON.stringify({ scripts: { build: "vite build" } });
const pkgNoBuild = JSON.stringify({ scripts: { dev: "vite" } });

test("build script + bun lockfile → bun run build", async () => {
  const d = tmp({ "package.json": pkgWithBuild, "bun.lock": "" });
  expect(await detectBuildCommand(d)).toEqual({ kind: "script", argv: ["bun", "run", "build"] });
});

test("build script + pnpm lockfile → pnpm run build", async () => {
  const d = tmp({ "package.json": pkgWithBuild, "pnpm-lock.yaml": "" });
  expect(await detectBuildCommand(d)).toEqual({ kind: "script", argv: ["pnpm", "run", "build"] });
});

test("build script + yarn lockfile → yarn run build", async () => {
  const d = tmp({ "package.json": pkgWithBuild, "yarn.lock": "" });
  expect(await detectBuildCommand(d)).toEqual({ kind: "script", argv: ["yarn", "run", "build"] });
});

test("build script + no lockfile → npm run build", async () => {
  const d = tmp({ "package.json": pkgWithBuild });
  expect(await detectBuildCommand(d)).toEqual({ kind: "script", argv: ["npm", "run", "build"] });
});

test("no build script but tsconfig + bun lockfile → bunx tsc --noEmit", async () => {
  const d = tmp({ "package.json": pkgNoBuild, "tsconfig.json": "{}", "bun.lock": "" });
  expect(await detectBuildCommand(d)).toEqual({ kind: "tsc", argv: ["bunx", "tsc", "--noEmit"] });
});

test("no build script + tsconfig + npm → npx tsc --noEmit", async () => {
  const d = tmp({ "package.json": pkgNoBuild, "tsconfig.json": "{}" });
  expect(await detectBuildCommand(d)).toEqual({ kind: "tsc", argv: ["npx", "tsc", "--noEmit"] });
});

test("tsconfig with no package.json → npx tsc --noEmit", async () => {
  const d = tmp({ "tsconfig.json": "{}" });
  expect(await detectBuildCommand(d)).toEqual({ kind: "tsc", argv: ["npx", "tsc", "--noEmit"] });
});

test("malformed package.json + tsconfig → falls through to tsc", async () => {
  const d = tmp({ "package.json": "{ not json", "tsconfig.json": "{}" });
  expect(await detectBuildCommand(d)).toEqual({ kind: "tsc", argv: ["npx", "tsc", "--noEmit"] });
});

test("neither build script nor tsconfig → null", async () => {
  const d = tmp({ "package.json": pkgNoBuild });
  expect(await detectBuildCommand(d)).toBeNull();
});

test("empty dir → null", async () => {
  const d = tmp({});
  expect(await detectBuildCommand(d)).toBeNull();
});
