import { expect, test } from "bun:test";
import { applyFilter } from "../../../src/tools/run-tests/filter";

// The runner-supplied filter is shell-quoted (single quotes) because it ends up in a
// shell-joined command — so a plain "slug" becomes "'slug'".
test("bun → -t <pattern> appended (quoted)", () => {
  expect(applyFilter({ runnerId: "bun", argv: ["bun", "test"] }, "slug")).toEqual({
    argv: ["bun", "test", "-t", "'slug'"],
    supported: true,
  });
});
test("pytest → -k <pattern> (quoted)", () => {
  expect(applyFilter({ runnerId: "pytest", argv: ["pytest"] }, "slug").argv).toEqual([
    "pytest",
    "-k",
    "'slug'",
  ]);
});
test("cargo → positional substring (quoted)", () => {
  expect(applyFilter({ runnerId: "cargo", argv: ["cargo", "test"] }, "slug").argv).toEqual([
    "cargo",
    "test",
    "'slug'",
  ]);
});
test("go → -run inserted BEFORE the package selector (quoted)", () => {
  expect(applyFilter({ runnerId: "go", argv: ["go", "test", "./..."] }, "Slug").argv).toEqual([
    "go",
    "test",
    "-run",
    "'Slug'",
    "./...",
  ]);
});
test("node/config → unsupported, argv unchanged", () => {
  expect(applyFilter({ runnerId: "node", argv: ["npm", "test"] }, "slug")).toEqual({
    argv: ["npm", "test"],
    supported: false,
  });
});

test("shell metacharacters in the filter are neutralized (command injection)", () => {
  const { argv } = applyFilter({ runnerId: "bun", argv: ["bun", "test"] }, "foo; rm -rf ~");
  // the payload is a single quoted argument — no bare ';' survives in the joined command
  expect(argv[argv.length - 1]).toBe("'foo; rm -rf ~'");
  expect(argv.join(" ")).toBe("bun test -t 'foo; rm -rf ~'");
});

test("embedded single quotes are escaped", () => {
  const { argv } = applyFilter({ runnerId: "pytest", argv: ["pytest"] }, "it's");
  expect(argv[argv.length - 1]).toBe("'it'\\''s'");
});
