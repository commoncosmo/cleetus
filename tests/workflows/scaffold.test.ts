import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowPackage } from "../../src/workflows/package";
import { scaffoldWorkflowPackage } from "../../src/workflows/scaffold";
import { parseWorkflowTestCase } from "../../src/workflows/test-case";

describe("scaffoldWorkflowPackage", () => {
  test("creates a complete, loadable project workflow skeleton", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-scaffold-"));
    const result = scaffoldWorkflowPackage({
      name: "repository-brief",
      description: "Summarize one repository",
      root,
      scope: "project",
    });

    expect(result).toEqual({
      name: "repository-brief",
      scope: "project",
      dir: join(root, "repository-brief"),
      files: ["workflow.yaml", "SKILL.md", "tests/skeleton.yaml"],
    });
    expect(existsSync(join(result.dir, "prompts"))).toBe(true);
    expect(existsSync(join(result.dir, "scripts"))).toBe(true);

    const pkg = loadWorkflowPackage(result.dir, "project");
    expect(pkg.manifest).toMatchObject({
      name: "repository-brief",
      revision: 1,
      description: "Summarize one repository",
      permissions: {},
      presentation: { output: "result" },
    });
    expect(pkg.files.find((file) => file.path === "SKILL.md")?.content).toContain(
      "Run the `repository-brief` Cleetus workflow",
    );
    expect(
      parseWorkflowTestCase(readFileSync(join(result.dir, "tests", "skeleton.yaml"), "utf8")),
    ).toMatchObject({
      name: "skeleton renders",
      inputs: {},
      mocks: {},
      expect: { status: "succeeded", attempts: { render: 1 } },
    });
  });

  test("rejects invalid names and never overwrites an existing package", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-scaffold-"));
    expect(() => scaffoldWorkflowPackage({ name: "Bad Name", root, scope: "project" })).toThrow(
      "lowercase letters",
    );

    scaffoldWorkflowPackage({ name: "report", root, scope: "project" });
    const before = readFileSync(join(root, "report", "workflow.yaml"), "utf8");
    expect(() =>
      scaffoldWorkflowPackage({
        name: "report",
        description: "Replacement",
        root,
        scope: "project",
      }),
    ).toThrow("already exists");
    expect(readFileSync(join(root, "report", "workflow.yaml"), "utf8")).toBe(before);
  });
});
