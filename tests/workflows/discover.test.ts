import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkflows } from "../../src/workflows/discover";

const MANIFEST = (name: string) => `
schema_version: 1
name: ${name}
revision: 1
description: ${name}
inputs: { type: object }
permissions: {}
execution: { timeout: 1m }
steps:
  - id: render
    uses: text.template@1
    with: { template: ok }
outputs:
  text: { value: "$steps.render.output", schema: { type: string } }
`;

function root(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function add(dir: string, name: string, manifest = MANIFEST(name)): void {
  const target = join(dir, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "workflow.yaml"), manifest);
}

describe("discoverWorkflows", () => {
  it("finds project and global directory packages and excludes drafts/flat files", () => {
    const project = root("wf-project-");
    const global = root("wf-global-");
    const projectRoot = join(project, ".cleetus", "workflows");
    const globalRoot = join(global, "workflows");
    add(projectRoot, "project-flow");
    add(globalRoot, "global-flow");
    add(join(projectRoot, ".drafts"), "draft-flow");
    writeFileSync(join(projectRoot, "flat.yaml"), "ignored");
    const result = discoverWorkflows({ projectDir: project, globalDir: global });
    expect(result.workflows.map((pkg) => pkg.name).sort()).toEqual(["global-flow", "project-flow"]);
  });

  it("keeps valid packages when another package is invalid", () => {
    const project = root("wf-project-");
    const projectRoot = join(project, ".cleetus", "workflows");
    add(projectRoot, "valid");
    add(projectRoot, "invalid", "not: a workflow");
    const result = discoverWorkflows({ projectDir: project, globalDir: root("wf-global-") });
    expect(result.workflows.map((pkg) => pkg.name)).toEqual(["valid"]);
    expect(result.diagnostics).toHaveLength(1);
  });
});
