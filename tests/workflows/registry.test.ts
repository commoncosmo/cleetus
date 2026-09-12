import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRegistry } from "../../src/workflows/registry";

function root(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function add(rootDir: string, relativeRoot: string, name: string, description: string): void {
  const dir = join(rootDir, relativeRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "workflow.yaml"),
    `
schema_version: 1
name: ${name}
revision: 1
description: ${description}
inputs: { type: object }
permissions: {}
execution: { timeout: 1m }
steps:
  - id: render
    uses: text.template@1
    with: { template: ok }
outputs:
  text: { value: "$steps.render.output", schema: { type: string } }
`,
  );
}

describe("WorkflowRegistry", () => {
  it("uses project-over-global precedence and reports shadowing", () => {
    const projectDir = root("wf-project-");
    const globalDir = root("wf-global-");
    add(projectDir, ".cleetus/workflows", "weather", "project");
    add(globalDir, "workflows", "weather", "global");
    const registry = new WorkflowRegistry({ projectDir, globalDir });
    expect(registry.get("weather")?.description).toBe("project");
    expect(registry.diagnostics()[0]?.message).toContain("shadowed");
  });

  it("lists deterministically, resolves unique prefixes, and refreshes", () => {
    const projectDir = root("wf-project-");
    const globalDir = root("wf-global-");
    add(projectDir, ".cleetus/workflows", "zulu", "z");
    add(projectDir, ".cleetus/workflows", "alpha", "a");
    const registry = new WorkflowRegistry({ projectDir, globalDir });
    expect(registry.list().map((pkg) => pkg.name)).toEqual(["alpha", "zulu"]);
    expect(registry.resolveName("alp")).toBe("alpha");
    add(projectDir, ".cleetus/workflows", "beta", "b");
    registry.refresh();
    expect(registry.get("beta")).toBeDefined();
  });
});
