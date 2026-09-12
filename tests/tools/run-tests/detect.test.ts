import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestConfig } from "../../../src/config/types";
import { detectTestCommand, hasStackMarker } from "../../../src/tools/run-tests/detect";

const CFG: TestConfig = {
  enabled: true,
  command: undefined,
  timeoutMs: 120_000,
  maxOutputLines: 120,
};

// which-stub: only the listed bins are "installed".
const whichOnly =
  (...present: string[]) =>
  (bin: string): string | null =>
    present.includes(bin) ? `/usr/bin/${bin}` : null;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rt-detect-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detectTestCommand", () => {
  test("config.command string short-circuits detection (runnerId config)", async () => {
    const r = await detectTestCommand(dir, { ...CFG, command: "make test" }, whichOnly());
    expect(r.command).toEqual({ runnerId: "config", argv: ["make", "test"] });
    expect(r.warnings).toEqual([]);
  });

  test("config.command array is used verbatim", async () => {
    const r = await detectTestCommand(
      dir,
      { ...CFG, command: ["bun", "test", "--bail"] },
      whichOnly(),
    );
    expect(r.command?.argv).toEqual(["bun", "test", "--bail"]);
  });

  test("bun.lockb + package.json → bun test", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "bun.lockb"), "");
    const r = await detectTestCommand(dir, CFG, whichOnly());
    expect(r.command).toEqual({ runnerId: "bun", argv: ["bun", "test"] });
  });

  test("bun.lock (text lockfile) + package.json → bun test", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "bun.lock"), "");
    const r = await detectTestCommand(dir, CFG, whichOnly());
    expect(r.command).toEqual({ runnerId: "bun", argv: ["bun", "test"] });
  });

  test("package.json scripts.test + pnpm-lock → pnpm test", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "");
    const r = await detectTestCommand(dir, CFG, whichOnly());
    expect(r.command?.argv).toEqual(["pnpm", "test"]);
    expect(r.command?.runnerId).toBe("node");
  });

  test("package.json scripts.test + yarn.lock → yarn test", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    await writeFile(join(dir, "yarn.lock"), "");
    const r = await detectTestCommand(dir, CFG, whichOnly());
    expect(r.command?.argv).toEqual(["yarn", "test"]);
  });

  test("package.json scripts.test, no lockfile → npm test", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    const r = await detectTestCommand(dir, CFG, whichOnly());
    expect(r.command?.argv).toEqual(["npm", "test"]);
  });

  test("package.json, no script, bun on PATH → bun test", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    const r = await detectTestCommand(dir, CFG, whichOnly("bun"));
    expect(r.command?.argv).toEqual(["bun", "test"]);
  });

  test("package.json, no script, no bun → warning, falls through to null", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    const r = await detectTestCommand(dir, CFG, whichOnly());
    expect(r.command).toBeNull();
    expect(r.warnings).toContain("node tests unavailable: no test script and bun not found");
  });

  test("malformed package.json is treated as no test script", async () => {
    await writeFile(join(dir, "package.json"), "{ not json");
    const r = await detectTestCommand(dir, CFG, whichOnly("bun"));
    expect(r.command?.argv).toEqual(["bun", "test"]); // falls to the bun-on-PATH branch
  });

  test("pyproject.toml + pytest on PATH → pytest with summaryRegex", async () => {
    await writeFile(join(dir, "pyproject.toml"), "");
    const r = await detectTestCommand(dir, CFG, whichOnly("pytest"));
    expect(r.command?.argv).toEqual(["pytest"]);
    expect(r.command?.runnerId).toBe("pytest");
    expect(r.command?.summaryRegex?.test("=== 1 passed in 0.01s ===")).toBe(true);
  });

  test("pyproject.toml but no pytest → warning, null", async () => {
    await writeFile(join(dir, "pyproject.toml"), "");
    const r = await detectTestCommand(dir, CFG, whichOnly());
    expect(r.command).toBeNull();
    expect(r.warnings).toContain("python tests unavailable: 'pytest' not found");
  });

  test("Cargo.toml + cargo on PATH → cargo test with summaryRegex", async () => {
    await writeFile(join(dir, "Cargo.toml"), "");
    const r = await detectTestCommand(dir, CFG, whichOnly("cargo"));
    expect(r.command?.argv).toEqual(["cargo", "test"]);
    expect(r.command?.summaryRegex?.test("test result: ok. 3 passed; 0 failed")).toBe(true);
  });

  test("go.mod + go on PATH → go test ./...", async () => {
    await writeFile(join(dir, "go.mod"), "module x");
    const r = await detectTestCommand(dir, CFG, whichOnly("go"));
    expect(r.command?.argv).toEqual(["go", "test", "./..."]);
  });

  test("no markers → null, no warnings", async () => {
    const r = await detectTestCommand(dir, CFG, whichOnly("bun", "pytest", "cargo", "go"));
    expect(r.command).toBeNull();
    expect(r.warnings).toEqual([]);
  });
});

describe("hasStackMarker", () => {
  test("true when a package.json is present", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    expect(await hasStackMarker(dir, CFG)).toBe(true);
  });
  test("true when config.command is set even with no marker files", async () => {
    expect(await hasStackMarker(dir, { ...CFG, command: "make test" })).toBe(true);
  });
  test("false for a bare directory", async () => {
    expect(await hasStackMarker(dir, CFG)).toBe(false);
  });
});

test("Bun lockfile respects the Vitest script rather than selecting Bun's native test runner", async () => {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run", build: "tsc -b && vite build" } }),
  );
  await writeFile(join(dir, "bun.lock"), "");
  expect((await detectTestCommand(dir, CFG, whichOnly())).command).toEqual({
    runnerId: "vitest",
    argv: ["bun", "run", "test"],
  });
  expect((await detectTestCommand(dir, CFG, whichOnly(), "build")).command?.argv).toEqual([
    "bun",
    "run",
    "build",
  ]);
});
