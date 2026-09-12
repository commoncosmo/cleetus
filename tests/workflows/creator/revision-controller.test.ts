import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowCreatorController } from "../../../src/workflows/creator/controller";
import { WorkflowDraftStore } from "../../../src/workflows/creator/draft-store";
import type {
  WorkflowCreatorOutput,
  WorkflowRevisionBase,
} from "../../../src/workflows/creator/types";
import { parseWorkflowManifest } from "../../../src/workflows/parse";
import { createDeterministicWorkflowStepRegistry } from "../../../src/workflows/steps";

function revisionBase(): WorkflowRevisionBase {
  return {
    name: "select-one",
    scope: "project",
    revision: 1,
    packageHash: "package-one",
    executionHash: "execution-one",
    manifest: parseWorkflowManifest(`
schema_version: 1
name: select-one
revision: 1
description: Select one value
inputs: { type: object, properties: {}, additionalProperties: false }
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
presentation: { output: result }
`),
    resources: [],
  };
}

function revisionOutput(
  base: WorkflowRevisionBase,
  operations: NonNullable<WorkflowCreatorOutput["changeSet"]>["operations"],
): WorkflowCreatorOutput {
  return {
    response: "Revision ready.",
    mode: "revise",
    phase: "draft",
    summary: "Clarify the workflow description",
    changeSet: {
      schemaVersion: 1,
      base: {
        name: base.name,
        scope: base.scope,
        revision: base.revision,
        packageHash: base.packageHash,
        executionHash: base.executionHash,
      },
      summary: "Clarify the workflow description",
      operations,
    },
    assumptions: [],
    unresolvedQuestions: [],
  };
}

describe("WorkflowCreatorController change-set revisions", () => {
  test("materializes a typed revision and persists its semantic evidence", async () => {
    const base = revisionBase();
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "revision-controller-")));
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond() {
          return revisionOutput(base, [
            {
              op: "set-description",
              id: "clarify-description",
              rationale: "Use the user's clearer wording",
              description: "Select and return one boolean value",
            },
          ]);
        },
      },
      "Revise workflows.",
      createDeterministicWorkflowStepRegistry(),
    );
    const draft = controller.start({
      name: base.name,
      scope: base.scope,
      targetRevision: 2,
      revisionBase: base,
      baseManifest: base.manifest,
      baseResources: base.resources,
    });

    const result = await controller.respond(draft.id, "Clarify the description.");

    expect(result.phase).toBe("draft");
    expect(result.output?.manifest?.description).toBe("Select and return one boolean value");
    expect(result.output?.manifest?.steps).toEqual(base.manifest.steps);
    expect(result.changeSet?.operations).toHaveLength(1);
    expect(result.semanticDiff).toMatchObject({
      targetRevision: 2,
      riskFlags: [],
      unattributedChanges: [],
      operationCoverage: [
        {
          operationId: "clarify-description",
          changeIds: ["metadata:description"],
        },
      ],
    });

    const persisted = store.get(draft.id)!;
    persisted.semanticDiff = {
      targetRevision: 99,
      changes: [],
      authority: { added: ["invented"], removed: [] },
      riskFlags: ["invented"],
      operationCoverage: [],
      derivedChanges: [],
      unattributedChanges: [],
    };
    persisted.output!.manifest!.description = "tampered serialized candidate";
    store.save(persisted);
    const restarted = new WorkflowCreatorController(
      store,
      {
        async respond() {
          throw new Error("restart inspection must not call the model");
        },
      },
      "Revise workflows.",
      createDeterministicWorkflowStepRegistry(),
    );
    expect(restarted.get(draft.id)).toMatchObject({
      output: { manifest: { description: "Select and return one boolean value" } },
      semanticDiff: {
        targetRevision: 2,
        authority: { added: [], removed: [] },
        riskFlags: [],
      },
    });
  });

  test("repairs with a complete replacement change set rebuilt from the immutable base", async () => {
    const base = revisionBase();
    let calls = 0;
    let repairFeedback = "";
    const controller = new WorkflowCreatorController(
      new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "revision-controller-"))),
      {
        async respond(input) {
          calls++;
          if (calls === 1) {
            return revisionOutput(base, [
              {
                op: "set-presentation",
                id: "invalid-presentation",
                rationale: "Select a missing output",
                presentation: { output: "missing" },
              },
            ]);
          }
          repairFeedback = input.messages.at(-1)?.content ?? "";
          return revisionOutput(base, [
            {
              op: "set-description",
              id: "clarify-description",
              rationale: "Use the user's clearer wording",
              description: "Select and return one boolean value",
            },
          ]);
        },
      },
      "Revise workflows.",
      createDeterministicWorkflowStepRegistry(),
    );
    const draft = controller.start({
      name: base.name,
      scope: base.scope,
      targetRevision: 2,
      revisionBase: base,
      baseManifest: base.manifest,
      baseResources: base.resources,
    });

    const result = await controller.respond(draft.id, "Clarify the description.");

    expect(calls).toBe(2);
    expect(repairFeedback).toContain("upsert-output => name, output");
    expect(repairFeedback).toContain('outputs: ["result"]');
    expect(repairFeedback).toContain('steps: ["select"]');
    expect(result.phase).toBe("draft");
    expect(result.output?.manifest?.presentation).toEqual(base.manifest.presentation);
    expect(result.output?.manifest?.description).toBe("Select and return one boolean value");
    expect(result.changeSet?.operations.map((operation) => operation.id)).toEqual([
      "clarify-description",
    ]);
  });

  test("retry sends an invalid persisted change set back through model repair", async () => {
    const base = revisionBase();
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "revision-controller-")));
    let calls = 0;
    let retryFeedback = "";
    let retryInputMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const controller = new WorkflowCreatorController(
      store,
      {
        async respond(input) {
          calls++;
          if (calls <= 2) {
            return revisionOutput(base, [
              {
                op: "upsert-output",
                id: "update-result",
                rationale: "Point at the revised result",
                output: {
                  value: "$steps.select.output",
                  schema: { type: "boolean" },
                },
              } as never,
            ]);
          }
          retryFeedback = input.messages.at(-1)?.content ?? "";
          retryInputMessages = structuredClone(input.messages);
          return revisionOutput(base, [
            {
              op: "upsert-output",
              id: "update-result",
              rationale: "Point at the revised result",
              name: "result",
              output: {
                value: "$steps.select.output",
                schema: { type: "boolean", title: "Formatted result" },
              },
            },
          ]);
        },
      },
      "Revise workflows.",
      createDeterministicWorkflowStepRegistry(),
    );
    const draft = controller.start({
      name: base.name,
      scope: base.scope,
      targetRevision: 2,
      revisionBase: base,
      baseManifest: base.manifest,
      baseResources: base.resources,
    });

    const failed = await controller.respond(draft.id, "Update the result formatting.");
    expect(calls).toBe(2);
    expect(failed.diagnostics).toContainEqual({
      path: "changeSet",
      message: "revision operation 'update-result' (upsert-output): missing required field 'name'",
    });

    const repaired = await controller.retry(draft.id);
    expect(calls).toBe(3);
    expect(repaired.phase).toBe("draft");
    expect(repaired.diagnostics).toEqual([]);
    expect(repaired.changeSet?.operations[0]).toMatchObject({
      op: "upsert-output",
      name: "result",
    });
    expect(retryFeedback).toContain('outputs: ["result"]');
    expect(retryFeedback).toContain("upsert-output => name, output");
    expect(retryFeedback).toContain("[Host retry rebase]");
    expect(retryFeedback).toContain("Discard every previous candidate");
    expect(retryInputMessages.some((message) => message.role === "assistant")).toBe(false);
    expect(
      retryInputMessages.some((message) =>
        message.content.startsWith("[Host validation feedback]"),
      ),
    ).toBe(false);
  });

  test("rejects an unrequested model formatter and a near-match output target", async () => {
    const base = revisionBase();
    const controller = new WorkflowCreatorController(
      new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "revision-controller-"))),
      {
        async respond() {
          return revisionOutput(base, [
            {
              op: "upsert-step",
              id: "format-list",
              rationale: "Number the output",
              step: {
                id: "format-list",
                uses: "llm.generate@1",
                with: {
                  prompt: "Turn the value into a numbered list.",
                  input: "$steps.select.output",
                  output_schema: { type: "string" },
                },
              },
              placement: { after: "select" },
            },
            {
              op: "upsert-output",
              id: "update-result",
              rationale: "Use the formatted output",
              name: "re-sult",
              output: {
                value: "$steps.format-list.output",
                schema: { type: "string" },
              },
            },
          ]);
        },
      },
      "Revise workflows.",
      createDeterministicWorkflowStepRegistry(),
    );
    const draft = controller.start({
      name: base.name,
      scope: base.scope,
      targetRevision: 2,
      revisionBase: base,
      baseManifest: base.manifest,
      baseResources: base.resources,
    });

    const result = await controller.respond(draft.id, "Render the output as a numbered list.");

    expect(result.diagnostics).toContainEqual({
      path: "changeSet",
      message:
        "revision introduces llm.generate@1 step 'format-list' without an explicit request for model behavior; line numbering is deterministic, so revise an existing deterministic step instead",
    });
    expect(result.diagnostics).toContainEqual({
      path: "changeSet.operations.update-result",
      message:
        "near-match target 're-sult' would create a new entity; use the exact immutable-base key 'result' to update the existing entity",
    });
    expect(result.messages.at(-1)?.content).toContain("Discard the rejected candidate completely");
    expect(result.messages.at(-1)?.content).not.toContain("Current complete change set:");
  });
});
