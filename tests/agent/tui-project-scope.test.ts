import { expect, test } from "bun:test";
import { join } from "node:path";
import { inheritedProjectMemoryPath, projectMemoryPath } from "../../src/agent/tui-project-scope";

test("no project home → cwd .cleetus/memory.md (loose behavior)", () => {
  expect(inheritedProjectMemoryPath("/work/repo", undefined, true)).toBe(
    join("/work/repo", ".cleetus", "memory.md"),
  );
});

test("project home + inherit → home .cleetus/memory.md", () => {
  expect(inheritedProjectMemoryPath("/work/repo", "/proj/acme", true)).toBe(
    join("/proj/acme", ".cleetus", "memory.md"),
  );
});

test("project home + opt-out → project memory is suppressed", () => {
  expect(inheritedProjectMemoryPath("/work/repo", "/proj/acme", false)).toBeUndefined();
});

test("project-scoped writes use the home when present and cwd otherwise", () => {
  expect(projectMemoryPath("/work/repo", "/proj/acme")).toBe(
    join("/proj/acme", ".cleetus", "memory.md"),
  );
  expect(projectMemoryPath("/work/repo")).toBe(join("/work/repo", ".cleetus", "memory.md"));
});
