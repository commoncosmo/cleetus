import { describe, expect, test } from "bun:test";
import {
  applyWorkflowRevision,
  validateWorkflowRevisionChangeSet,
} from "../../../src/workflows/creator/revision-apply";
import { buildWorkflowSemanticDiff } from "../../../src/workflows/creator/revision-diff";
import type {
  WorkflowRevisionBase,
  WorkflowRevisionChangeSet,
} from "../../../src/workflows/creator/types";
import { parseWorkflowManifest } from "../../../src/workflows/parse";

function base(): WorkflowRevisionBase {
  return {
    name: "decision-review",
    scope: "project",
    revision: 1,
    packageHash: "package-one",
    executionHash: "execution-one",
    manifest: parseWorkflowManifest(`
schema_version: 1
name: decision-review
revision: 1
description: Review a decision
inputs: { type: object, properties: {}, additionalProperties: false }
permissions: { model: true }
execution: { timeout: 5m }
steps:
  - id: recommend
    uses: llm.generate@1
    timeout: 2m
    with:
      prompt: ./prompts/recommend.md
      input: null
      output_schema:
        type: object
        required: [recommendation]
        properties: { recommendation: { type: string } }
        additionalProperties: false
outputs:
  result:
    value: $steps.recommend.output
    schema: { type: object }
presentation: { output: result }
`),
    resources: [
      { path: "prompts/recommend.md", content: "Recommend one option.\n" },
      {
        path: "tests/basic.yaml",
        content:
          "schema_version: 1\nname: basic\nmode: mock\ninputs: {}\nmocks: {}\nexpect: { status: succeeded }\n",
      },
    ],
  };
}

function changeSet(
  workflowBase: WorkflowRevisionBase,
  operations: WorkflowRevisionChangeSet["operations"],
): WorkflowRevisionChangeSet {
  return {
    schemaVersion: 1,
    base: {
      name: workflowBase.name,
      scope: workflowBase.scope,
      revision: workflowBase.revision,
      packageHash: workflowBase.packageHash,
      executionHash: workflowBase.executionHash,
    },
    summary: "Change presentation wording",
    operations,
  };
}

describe("workflow revision change sets", () => {
  test("applies only explicit resource operations and attributes a resource-only diff", () => {
    const workflowBase = base();
    const changes = changeSet(workflowBase, [
      {
        op: "put-resource",
        id: "update-prompt",
        rationale: "Add the requested greeting",
        path: "prompts/recommend.md",
        content: "Recommend one option and end with howdy y'all.\n",
      },
      {
        op: "put-resource",
        id: "update-test",
        rationale: "Keep the exact offline expectation synchronized",
        path: "tests/basic.yaml",
        content:
          "schema_version: 1\nname: basic\nmode: mock\ninputs: {}\nmocks: {}\nexpect: { status: succeeded }\n# howdy y'all\n",
      },
    ]);

    const candidate = applyWorkflowRevision(workflowBase, changes);
    const diff = buildWorkflowSemanticDiff(workflowBase, changes, candidate);

    expect(candidate.manifest.revision).toBe(2);
    expect(candidate.manifest.steps).toEqual(workflowBase.manifest.steps);
    expect(candidate.manifest.execution).toEqual(workflowBase.manifest.execution);
    expect(candidate.manifest.permissions).toEqual(workflowBase.manifest.permissions);
    expect(diff.unattributedChanges).toEqual([]);
    expect(diff.riskFlags).toContain("packaged resource-only change");
    expect(diff.operationCoverage).toEqual([
      {
        operationId: "update-prompt",
        changeIds: ["resources:prompts/recommend.md"],
      },
      { operationId: "update-test", changeIds: ["tests:tests/basic.yaml"] },
    ]);
  });

  test("preserves omitted resources and requires explicit deletion", () => {
    const workflowBase = base();
    const preserved = applyWorkflowRevision(
      workflowBase,
      changeSet(workflowBase, [
        {
          op: "set-description",
          id: "clarify-description",
          rationale: "Clarify the purpose",
          description: "Review and recommend one decision",
        },
      ]),
    );
    expect(preserved.resources).toEqual(workflowBase.resources);

    const removed = applyWorkflowRevision(
      workflowBase,
      changeSet(workflowBase, [
        {
          op: "delete-resource",
          id: "remove-test",
          rationale: "Remove the obsolete test",
          path: "tests/basic.yaml",
        },
      ]),
    );
    expect(removed.resources.map((resource) => resource.path)).toEqual(["prompts/recommend.md"]);
    const removalDiff = buildWorkflowSemanticDiff(
      workflowBase,
      changeSet(workflowBase, [
        {
          op: "delete-resource",
          id: "remove-test",
          rationale: "Remove the obsolete test",
          path: "tests/basic.yaml",
        },
      ]),
      removed,
    );
    expect(removalDiff.riskFlags).toContain("test removed");
    expect(removalDiff.riskFlags).toContain("packaged resource-only change");
    expect(removalDiff.riskFlags).not.toContain("presentation-only change");
  });

  test("uses stable step ids for insertion and movement", () => {
    const workflowBase = base();
    const changes = changeSet(workflowBase, [
      {
        op: "upsert-step",
        id: "add-render",
        rationale: "Render the recommendation",
        step: {
          id: "render",
          uses: "text.template@1",
          with: {
            data: "$steps.recommend.output",
            template: "{{recommendation}}",
          },
        },
        placement: { after: "recommend" },
      },
      {
        op: "move-step",
        id: "move-recommend",
        rationale: "Move recommendation after rendering for the requested test",
        stepId: "recommend",
        placement: { after: "render" },
      },
    ]);
    const candidate = applyWorkflowRevision(workflowBase, changes);
    expect(candidate.manifest.steps.map((step) => step.id)).toEqual(["render", "recommend"]);
  });

  test("reports authority and execution-policy changes deterministically", () => {
    const workflowBase = base();
    const expanded = changeSet(workflowBase, [
      {
        op: "set-permissions",
        id: "allow-api",
        rationale: "Call the requested API",
        permissions: {
          ...workflowBase.manifest.permissions,
          network: [{ host: "api.example.com", methods: ["GET"] }],
        },
      },
      {
        op: "upsert-step",
        id: "raise-timeout",
        rationale: "Allow the existing model more time",
        step: {
          ...workflowBase.manifest.steps[0]!,
          timeout: "3m",
        },
      },
    ]);
    const candidate = applyWorkflowRevision(workflowBase, expanded);
    const diff = buildWorkflowSemanticDiff(workflowBase, expanded, candidate);

    expect(diff.authority.added).toEqual(["network:GET:api.example.com"]);
    expect(diff.riskFlags).toContain("authority increased");
    expect(diff.riskFlags).toContain("step execution policy changed");

    const reduced = changeSet(workflowBase, [
      {
        op: "set-permissions",
        id: "remove-model",
        rationale: "Remove model authority",
        permissions: {},
      },
    ]);
    const reducedDiff = buildWorkflowSemanticDiff(
      workflowBase,
      reduced,
      applyWorkflowRevision(workflowBase, reduced),
    );
    expect(reducedDiff.authority.removed).toEqual(["model"]);
    expect(reducedDiff.authority.added).toEqual([]);
  });

  test("treats a command argument prefix as an authority reduction", () => {
    const workflowBase = base();
    workflowBase.manifest.permissions = {
      commands: [{ program: "bash" }],
      filesystem: { read: ["$project/**"] },
    };
    const exactCommand = "find . -type f -exec sha1sum {} \\; | awk '{print NR \". \" $0}'";
    const changes = changeSet(workflowBase, [
      {
        op: "set-permissions",
        id: "narrow-bash-permission",
        rationale: "Authorize only the command used by the existing step",
        permissions: {
          commands: [
            {
              program: "bash",
              args_prefix: ["-c", exactCommand],
            },
          ],
          filesystem: { read: ["$project/**"] },
        },
      },
    ]);
    const diff = buildWorkflowSemanticDiff(
      workflowBase,
      changes,
      applyWorkflowRevision(workflowBase, changes),
    );

    expect(diff.authority.added).toEqual([]);
    expect(diff.authority.removed).toEqual(["command:bash"]);
    expect(diff.riskFlags).not.toContain("authority increased");
    expect(diff.unattributedChanges).toEqual([]);
  });

  test("rejects stale bases, duplicate targets, implicit deletion, and unsafe resources", () => {
    const workflowBase = base();
    const stale = changeSet(workflowBase, []);
    stale.base.packageHash = "other";
    expect(() => validateWorkflowRevisionChangeSet(workflowBase, stale)).toThrow(
      "does not match its base",
    );

    expect(() =>
      applyWorkflowRevision(
        workflowBase,
        changeSet(workflowBase, [
          {
            op: "set-description",
            id: "one",
            rationale: "First",
            description: "One",
          },
          {
            op: "set-description",
            id: "two",
            rationale: "Second",
            description: "Two",
          },
        ]),
      ),
    ).toThrow("already owned");
    expect(() =>
      applyWorkflowRevision(
        workflowBase,
        changeSet(workflowBase, [
          {
            op: "delete-resource",
            id: "missing",
            rationale: "Delete it",
            path: "prompts/missing.md",
          },
        ]),
      ),
    ).toThrow("does not exist");
    expect(() =>
      applyWorkflowRevision(
        workflowBase,
        changeSet(workflowBase, [
          {
            op: "put-resource",
            id: "escape",
            rationale: "Escape",
            path: "scripts/../../escape.ts",
            content: "",
          },
        ]),
      ),
    ).toThrow("must stay under");
  });

  test("reports the exact malformed operation instead of oneOf branch noise", () => {
    const workflowBase = base();
    expect(() =>
      validateWorkflowRevisionChangeSet(
        workflowBase,
        changeSet(workflowBase, [
          {
            op: "upsert-step",
            id: "number-output",
            rationale: "Render a numbered list",
            description: "This field belongs to a different operation",
          } as never,
        ]),
      ),
    ).toThrow("revision operation 'number-output' (upsert-step): missing required field 'step'");

    expect(() =>
      validateWorkflowRevisionChangeSet(
        workflowBase,
        changeSet(workflowBase, [
          {
            op: "set-description",
            id: "hybrid-operation",
            rationale: "Reject hybrid operation fields",
            description: "Updated",
            stepId: "recommend",
          } as never,
        ]),
      ),
    ).toThrow("field 'stepId' is not allowed for set-description");
  });
});
