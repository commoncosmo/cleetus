import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowPackage } from "../../src/workflows/package";

function makePackage(): string {
  const parent = mkdtempSync(join(tmpdir(), "cleetus-workflow-package-"));
  const dir = join(parent, "weather");
  mkdirSync(join(dir, "prompts"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "workflow.yaml"),
    `
schema_version: 1
name: weather
revision: 1
description: Weather
inputs: { type: object }
permissions: {}
execution: { timeout: 1m }
steps:
  - id: summarize
    uses: llm.generate@1
    with: { prompt_file: prompts/summarize.md }
outputs:
  text: { value: "$steps.summarize.output", schema: { type: string } }
`,
  );
  writeFileSync(join(dir, "prompts", "summarize.md"), "summarize");
  writeFileSync(join(dir, "tests", "default.yaml"), "name: default");
  return dir;
}

describe("loadWorkflowPackage", () => {
  it("loads resources and separates package from execution identity", () => {
    const pkg = loadWorkflowPackage(makePackage(), "project");
    expect(pkg.runtimeResources.map((file) => file.path)).toEqual(["prompts/summarize.md"]);
    expect(pkg.packageHash).not.toBe(pkg.executionHash);
  });

  it("rejects name mismatches and symlinks", () => {
    const dir = makePackage();
    writeFileSync(join(dir, "workflow.yaml"), "schema_version: 1\nname: other\n");
    expect(() => loadWorkflowPackage(dir, "project")).toThrow();

    const linked = makePackage();
    symlinkSync(join(linked, "prompts", "summarize.md"), join(linked, "linked.md"));
    expect(() => loadWorkflowPackage(linked, "project")).toThrow("contains symlink");
  });

  it("reports a missing runtime resource before resolving its real path", () => {
    const dir = makePackage();
    writeFileSync(
      join(dir, "workflow.yaml"),
      `
schema_version: 1
name: weather
revision: 1
description: Weather
inputs: { type: object }
permissions: {}
execution: { timeout: 1m }
steps:
  - id: run
    uses: command.run@1
    with: { program: bun, args: [run, ./scripts/missing], output: json }
outputs:
  result: { value: "$steps.run.output.stdout", schema: {} }
`,
    );
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "available.ts"), "console.log('{}');\n");

    expect(() => loadWorkflowPackage(dir, "project")).toThrow(
      "workflow resource is missing: scripts/missing; available packaged resources: prompts/summarize.md, scripts/available.ts",
    );
  });
});
