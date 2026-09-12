import { describe, expect, it } from "bun:test";
import { hasImplementationWrite, isImplementationPath } from "../../src/agent/change-kind";
import type { Message } from "../../src/providers/types";

describe("isImplementationPath", () => {
  it("recognizes source, tests, runtime config, and web implementation", () => {
    for (const path of [
      "src/router.ts",
      "tests/router.test.ts",
      "package.json",
      "tsconfig.json",
      "config.yaml",
      "deploy/values.yaml",
      ".github/workflows/ci.yml",
      "migrations/001.sql",
      "public/index.html",
      "src/styles.css",
    ]) {
      expect(isImplementationPath(path)).toBe(true);
    }
  });

  it("keeps data and document artifacts out of implementation", () => {
    for (const path of [
      "wilmette_forecast.json",
      "exports/results.csv",
      "docs/notes.md",
      "report.txt",
      "assets/logo.png",
    ]) {
      expect(isImplementationPath(path)).toBe(false);
    }
  });
});

describe("hasImplementationWrite", () => {
  const messages = (name: string, args: unknown): Message[] => [
    { role: "assistant", content: "", toolCalls: [{ id: "1", name, args }] },
  ];

  it("detects structured writes to implementation paths", () => {
    expect(hasImplementationWrite(messages("write_file", { path: "src/app.ts" }))).toBe(true);
    expect(
      hasImplementationWrite(
        messages("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/app.ts\n" }),
      ),
    ).toBe(true);
  });

  it("ignores structured writes to data artifacts", () => {
    expect(hasImplementationWrite(messages("write_file", { path: "wilmette_forecast.json" }))).toBe(
      false,
    );
  });
});
