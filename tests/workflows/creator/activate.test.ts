import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateWorkflowDraft } from "../../../src/workflows/creator/activate";
import { loadWorkflowPackage } from "../../../src/workflows/package";
import { WorkflowRegistry } from "../../../src/workflows/registry";
import { WorkflowService } from "../../../src/workflows/service";
import { createDeterministicWorkflowStepRegistry } from "../../../src/workflows/steps";

function draft(root: string, revision = 1) {
  const dir = join(root, "select-one");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "workflow.yaml"),
    `
schema_version: 1
name: select-one
revision: ${revision}
description: Select a value
inputs: { type: object }
permissions: {}
execution: { timeout: 10s }
steps:
  - id: select
    uses: data.select@1
    with: { value: { ok: true }, pointer: /ok }
outputs:
  result:
    value: $steps.select.output
    schema: { type: boolean }
`,
  );
  return dir;
}

describe("activateWorkflowDraft", () => {
  test("activates validated content without running and refuses silent overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-activate-"));
    const activeRoot = join(root, "active");
    const input = {
      draftPackageDir: draft(join(root, "draft")),
      activeRoot,
      scope: "project" as const,
      steps: createDeterministicWorkflowStepRegistry(),
    };
    const result = activateWorkflowDraft(input);
    expect(existsSync(join(result.activeDir, "workflow.yaml"))).toBe(true);
    expect(existsSync(join(result.activeDir, "SKILL.md"))).toBe(true);
    expect(() => activateWorkflowDraft(input)).toThrow("explicit approval");
  });

  test("backs up the previous revision on explicit replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-activate-"));
    const activeRoot = join(root, ".cleetus", "workflows");
    const steps = createDeterministicWorkflowStepRegistry();
    activateWorkflowDraft({
      draftPackageDir: draft(join(root, "one"), 1),
      activeRoot,
      scope: "project",
      steps,
    });
    const replaced = activateWorkflowDraft({
      draftPackageDir: draft(join(root, "two"), 2),
      activeRoot,
      scope: "project",
      steps,
      replace: true,
    });
    expect(replaced.backupDir).toBeDefined();
    expect(existsSync(join(replaced.backupDir!, "workflow.yaml"))).toBe(true);

    const service = new WorkflowService({
      registry: new WorkflowRegistry({
        projectDir: root,
        globalDir: join(root, "global"),
      }),
      workspace: root,
      stepRegistry: () => steps,
      openStore: () => {
        throw new Error("run store should not be opened");
      },
    });
    expect(service.show("select-one").manifest.revision).toBe(2);
    expect(service.showRevision("select-one", 1)?.manifest.revision).toBe(1);
  });

  test("blocks replacement when the active package changed after revision authoring began", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-activate-"));
    const activeRoot = join(root, "active");
    const steps = createDeterministicWorkflowStepRegistry();
    const activated = activateWorkflowDraft({
      draftPackageDir: draft(join(root, "one"), 1),
      activeRoot,
      scope: "project",
      steps,
    });
    const base = loadWorkflowPackage(activated.activeDir, "project");
    writeFileSync(
      join(activated.activeDir, "workflow.yaml"),
      `
schema_version: 1
name: select-one
revision: 1
description: Changed outside the draft
inputs: { type: object }
permissions: {}
execution: { timeout: 10s }
steps:
  - id: select
    uses: data.select@1
    with: { value: { ok: true }, pointer: /ok }
outputs:
  result:
    value: $steps.select.output
    schema: { type: boolean }
`,
    );

    expect(() =>
      activateWorkflowDraft({
        draftPackageDir: draft(join(root, "two"), 2),
        activeRoot,
        scope: "project",
        steps,
        replace: true,
        expectedBase: {
          name: base.name,
          scope: base.source,
          revision: base.manifest.revision,
          packageHash: base.packageHash,
          executionHash: base.executionHash,
          manifest: base.manifest,
          resources: [],
        },
      }),
    ).toThrow("changed after this revision draft began");
    expect(loadWorkflowPackage(activated.activeDir, "project").manifest.description).toBe(
      "Changed outside the draft",
    );
  });
});
