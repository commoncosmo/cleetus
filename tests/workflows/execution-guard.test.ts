import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDraftStore } from "../../src/workflows/creator/draft-store";
import {
  WorkflowDraftExecutionGuard,
  isValidReplacementDraft,
} from "../../src/workflows/execution-guard";
import { loadWorkflowPackage } from "../../src/workflows/package";
import { WorkflowRegistry } from "../../src/workflows/registry";
import { WorkflowService } from "../../src/workflows/service";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workflow-execution-guard-"));
  const workflowsRoot = join(root, ".cleetus", "workflows");
  const packageDir = join(workflowsRoot, "weather");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "workflow.yaml"),
    `
schema_version: 1
name: weather
revision: 1
description: Summarize weather
inputs: { type: object, properties: {}, additionalProperties: false }
permissions: {}
execution: { timeout: 10s }
steps:
  - id: value
    uses: data.select@1
    with: { value: "mild", pointer: "" }
outputs:
  result: { value: $steps.value.output, schema: {} }
`,
  );
  const store = new WorkflowDraftStore(workflowsRoot);
  const pkg = loadWorkflowPackage(packageDir, "project");
  return { root, workflowsRoot, store, pkg };
}

function replacement(
  store: WorkflowDraftStore,
  manifest: ReturnType<typeof loadWorkflowPackage>["manifest"],
  sessionId = "authoring-session",
) {
  const draft = store.create({
    scope: "project",
    name: "weather",
    sessionId,
    targetRevision: 2,
  });
  draft.phase = "draft";
  draft.output = {
    response: "Ready",
    phase: "draft",
    manifest: {
      ...manifest,
      revision: 2,
    },
    assumptions: [],
    unresolvedQuestions: [],
  };
  store.save(draft);
  return draft;
}

describe("WorkflowDraftExecutionGuard", () => {
  test("blocks only a complete valid replacement draft for the active source and newer revision", () => {
    const { store, pkg } = fixture();
    const draft = replacement(store, pkg.manifest);
    const guard = new WorkflowDraftExecutionGuard(store);

    expect(isValidReplacementDraft(draft, pkg)).toBe(true);
    expect(guard.conflict(pkg)).toMatchObject({
      workflow: "weather",
      activeRevision: 1,
      pendingRevision: 2,
    });

    for (const phase of ["questions", "generating", "failed", "cancelled", "activated"] as const) {
      draft.phase = phase;
      store.save(draft);
      expect(guard.conflict(pkg)).toBeUndefined();
    }

    draft.phase = "draft";
    draft.diagnostics = [{ path: "steps.0", message: "invalid" }];
    store.save(draft);
    expect(guard.conflict(pkg)).toBeUndefined();

    draft.diagnostics = [];
    draft.scope = "global";
    store.save(draft);
    expect(guard.conflict(pkg)).toBeUndefined();

    draft.scope = "project";
    draft.targetRevision = 1;
    draft.output!.manifest!.revision = 1;
    store.save(draft);
    expect(guard.conflict(pkg)).toBeUndefined();
  });

  test("persists across service restarts and blocks another session before journal or authorization", async () => {
    const { root, workflowsRoot, store, pkg } = fixture();
    const draft = replacement(store, pkg.manifest, "session-one");
    let storesOpened = 0;
    let authorizations = 0;
    const makeService = () =>
      new WorkflowService({
        registry: new WorkflowRegistry({
          projectDir: root,
          globalDir: join(root, "global"),
        }),
        workspace: root,
        executionGuard: new WorkflowDraftExecutionGuard(new WorkflowDraftStore(workflowsRoot)),
        openStore() {
          storesOpened++;
          throw new Error("journal must not be opened");
        },
        async authorize() {
          authorizations++;
          return "allow_once";
        },
        stepRegistry() {
          throw new Error("package validation must not run");
        },
      });

    expect(makeService().executionConflict("weather")).toMatchObject({
      draftId: draft.id,
      pendingRevision: 2,
    });
    await expect(makeService().run({ name: "weather", inputs: {} })).rejects.toMatchObject({
      code: "replacement_pending",
      message: expect.stringContaining("active revision 1 was not run"),
    });
    expect(storesOpened).toBe(0);
    expect(authorizations).toBe(0);

    store.discard(draft.id);
    expect(makeService().executionConflict("weather")).toBeUndefined();

    const activated = replacement(store, pkg.manifest, "session-one");
    activated.phase = "activated";
    store.save(activated);
    expect(makeService().executionConflict("weather")).toBeUndefined();
  });
});
