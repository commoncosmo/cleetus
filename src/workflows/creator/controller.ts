import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { renderWorkflowSkillAdapter } from "../adapter";
import { applyWorkflowInputDefaults } from "../input-defaults";
import { loadWorkflowPackage } from "../package";
import type { WorkflowManifest } from "../parse";
import { WorkflowSchemaService } from "../schema";
import type { WorkflowStepRegistry } from "../step-registry";
import { parseWorkflowTestCase } from "../test-case";
import { runWorkflowTestCase } from "../test-runner";
import type { JsonObject, JsonValue } from "../types";
import { validateWorkflowPackage } from "../validate";
import { compileWorkflowCreation } from "./creation-compiler";
import type { WorkflowDraftStore } from "./draft-store";
import {
  type WorkflowCreatorModel,
  normalizeSafeStaticLlmInput,
  workflowCreatorAttemptedResponses,
} from "./model";
import { applyWorkflowRevision } from "./revision-apply";
import { buildWorkflowSemanticDiff, deriveLegacyWorkflowChangeSet } from "./revision-diff";
import { workflowRevisionOperationFieldGuide } from "./revision-schema";
import type {
  WorkflowCreatorOutput,
  WorkflowCreatorResource,
  WorkflowDraftRecord,
  WorkflowRevisionBase,
} from "./types";

function safeResource(resource: WorkflowCreatorResource): string {
  const path = resource.path.replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    path.includes("../") ||
    !/^(?:prompts|scripts|tests)\/[A-Za-z0-9._/-]+$/u.test(path)
  ) {
    throw new Error(`unsafe workflow resource path '${resource.path}'`);
  }
  return path;
}

function validationRepairMessage(draft: WorkflowDraftRecord): string {
  const base = draft.revisionBase;
  const discardCandidate = draft.diagnostics.some(
    (diagnostic) =>
      diagnostic.message.includes("without an explicit request for model behavior") ||
      diagnostic.message.includes("near-match target"),
  );
  const revisionContext =
    draft.revisionProtocol === "change-set-v1"
      ? [
          "Operation required fields:",
          workflowRevisionOperationFieldGuide(),
          ...(base
            ? [
                "Exact immutable-base entity keys:",
                `steps: ${JSON.stringify(base.manifest.steps.map((step) => step.id))}`,
                `outputs: ${JSON.stringify(Object.keys(base.manifest.outputs))}`,
                `secrets: ${JSON.stringify(Object.keys(base.manifest.secrets ?? {}))}`,
                `resources: ${JSON.stringify(base.resources.map((resource) => resource.path))}`,
              ]
            : []),
          ...(discardCandidate
            ? [
                "Discard the rejected candidate completely. Rebuild from the immutable base and the user's original requirement; do not preserve its steps, targets, resources, or design choices.",
              ]
            : [
                "Current complete change set:",
                JSON.stringify(draft.changeSet ?? draft.output?.changeSet ?? null),
                ...(draft.semanticDiff
                  ? ["Current host semantic diff:", JSON.stringify(draft.semanticDiff)]
                  : []),
              ]),
        ]
      : [];
  return [
    "[Host validation feedback]",
    draft.revisionProtocol === "change-set-v1"
      ? "The materialized revision is not valid. Return one complete corrected change set against the same immutable base. Do not return a full manifest, patch the failed candidate, or change the user's requirements."
      : draft.creationProtocol === "blueprint-v1"
        ? "The compiled workflow is not valid. Discard the rejected candidate and rebuild one complete blueprint only from the original requirement transcript. Do not patch or copy the failed candidate, and do not change the user's requirements."
        : "The proposed manifest is not valid. Repair these technical DSL errors without asking the user to interpret them or changing the user's requirements.",
    ...draft.diagnostics.slice(0, 20).map((issue) => `- ${issue.path}: ${issue.message}`),
    ...revisionContext,
    draft.revisionProtocol === "change-set-v1"
      ? "Return one complete corrected revision response with mode 'revise' and phase 'draft'."
      : draft.creationProtocol === "blueprint-v1"
        ? "Return one complete replacement workflow blueprint with phase 'draft'."
        : "Return one complete corrected workflow-creator response with phase 'draft'.",
  ].join("\n");
}

function immutableBaseEntityGuide(draft: WorkflowDraftRecord): string[] {
  const base = draft.revisionBase;
  if (!base) return [];
  return [
    `steps: ${JSON.stringify(base.manifest.steps.map((step) => step.id))}`,
    `outputs: ${JSON.stringify(Object.keys(base.manifest.outputs))}`,
    `secrets: ${JSON.stringify(Object.keys(base.manifest.secrets ?? {}))}`,
    `resources: ${JSON.stringify(base.resources.map((resource) => resource.path))}`,
  ];
}

function revisionRetryMessages(draft: WorkflowDraftRecord): WorkflowDraftRecord["messages"] {
  const immutableContext = draft.messages.find(
    (message) => message.role === "user" && message.content.startsWith("[Host revision context]"),
  );
  const requirements = draft.messages.filter(
    (message) => message.role === "user" && !message.content.startsWith("[Host "),
  );
  return [
    ...(immutableContext ? [immutableContext] : []),
    ...requirements,
    {
      role: "user",
      content: [
        "[Host retry rebase]",
        "Discard every previous candidate and assistant proposal. Rebuild one complete replacement change set only from the immutable base and the user's original requirements above.",
        ...draft.diagnostics.map((diagnostic) => `- Previous failure: ${diagnostic.message}`),
        "Operation required fields:",
        workflowRevisionOperationFieldGuide(),
        "Exact immutable-base entity keys:",
        ...immutableBaseEntityGuide(draft),
        "Copy existing target keys byte-for-byte. Do not turn underscores into hyphens.",
        "A numbered-list or line-numbering request is deterministic. Revise an existing deterministic step and its offline test; do not add llm.generate@1.",
      ].join("\n"),
    },
  ];
}

function blueprintRequirementMessages(draft: WorkflowDraftRecord): WorkflowDraftRecord["messages"] {
  if (draft.requirementMessages) return structuredClone(draft.requirementMessages);
  return draft.messages.filter(
    (message) => message.role === "user" && !message.content.startsWith("[Host "),
  );
}

function blueprintRetryMessage(draft: WorkflowDraftRecord): string {
  return [
    "[Host retry rebase]",
    "Discard every previous candidate and assistant proposal. Rebuild one complete workflow blueprint only from the original requirement transcript.",
    ...draft.diagnostics
      .slice(0, 20)
      .map((diagnostic) => `- Previous failure at ${diagnostic.path}: ${diagnostic.message}`),
    "Do not patch or copy a rejected candidate. Return one complete replacement workflow blueprint.",
  ].join("\n");
}

function blueprintRetryMessages(
  draft: WorkflowDraftRecord,
  feedback = validationRepairMessage(draft),
): WorkflowDraftRecord["messages"] {
  return [
    ...blueprintRequirementMessages(draft),
    {
      role: "user",
      content: feedback,
    },
  ];
}

function resetBlueprintCandidate(
  draft: WorkflowDraftRecord,
  discardCandidate = true,
  feedback?: string,
): void {
  draft.messages = blueprintRetryMessages(draft, feedback);
  if (discardCandidate) {
    draft.output = undefined;
    draft.changeSet = undefined;
    draft.semanticDiff = undefined;
    draft.lastError = undefined;
    draft.attemptedResponses = undefined;
  }
}

function normalizedEntityName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function nearMatch(candidate: string, existing: readonly string[]): string | undefined {
  if (existing.includes(candidate)) return undefined;
  const normalized = normalizedEntityName(candidate);
  return existing.find((name) => normalizedEntityName(name) === normalized);
}

function revisionPolicyDiagnostics(
  draft: WorkflowDraftRecord,
  output: WorkflowCreatorOutput,
): Array<{ path: string; message: string }> {
  const base = draft.revisionBase;
  const manifest = output.manifest;
  const changeSet = output.changeSet;
  if (!base || !manifest || !changeSet) return [];
  const diagnostics: Array<{ path: string; message: string }> = [];
  const humanRequest = draft.messages
    .filter((message) => message.role === "user" && !message.content.startsWith("[Host "))
    .map((message) => message.content)
    .join("\n");
  const explicitlyRequestsModel =
    /\b(?:llm|large language model|language model|ai model|model-based|use (?:a|an) model)\b/iu.test(
      humanRequest,
    );
  const requestsDeterministicList =
    /\b(?:numbered list|number (?:each|the) line|number the (?:items|lines)|prefix each line|render (?:it|the output) as (?:a )?(?:numbered|bulleted) list)\b/iu.test(
      humanRequest,
    );
  const baseModelSteps = new Set(
    base.manifest.steps.filter((step) => step.uses === "llm.generate@1").map((step) => step.id),
  );
  const introducedModelSteps = manifest.steps.filter(
    (step) => step.uses === "llm.generate@1" && !baseModelSteps.has(step.id),
  );
  if (requestsDeterministicList && !explicitlyRequestsModel && introducedModelSteps.length > 0) {
    diagnostics.push({
      path: "changeSet",
      message: `revision introduces llm.generate@1 step '${introducedModelSteps[0]!.id}' without an explicit request for model behavior; line numbering is deterministic, so revise an existing deterministic step instead`,
    });
  }

  for (const operation of changeSet.operations) {
    let match: string | undefined;
    let candidate: string | undefined;
    if (operation.op === "upsert-output") {
      candidate = operation.name;
      match = nearMatch(operation.name, Object.keys(base.manifest.outputs));
    } else if (operation.op === "upsert-secret") {
      candidate = operation.name;
      match = nearMatch(operation.name, Object.keys(base.manifest.secrets ?? {}));
    } else if (operation.op === "upsert-step") {
      candidate = operation.step.id;
      match = nearMatch(
        operation.step.id,
        base.manifest.steps.map((step) => step.id),
      );
    }
    if (match && candidate) {
      diagnostics.push({
        path: `changeSet.operations.${operation.id}`,
        message: `near-match target '${candidate}' would create a new entity; use the exact immutable-base key '${match}' to update the existing entity`,
      });
    }
  }
  return diagnostics;
}

const EXTERNAL_STEP_TYPES = new Set(["http.request@1", "llm.generate@1", "command.run@1"]);

function missingDataSelectFallbackGuidance(
  pkg: ReturnType<typeof loadWorkflowPackage>,
  failures: string[],
): string {
  for (const failure of failures) {
    const match = /step '([^']+)' failed: JSON Pointer '([^']+)' did not match a value/u.exec(
      failure,
    );
    if (!match) continue;
    const step = pkg.manifest.steps.find((candidate) => candidate.id === match[1]);
    if (
      step?.uses !== "data.select@1" ||
      !step.with ||
      typeof step.with !== "object" ||
      Array.isArray(step.with) ||
      Object.hasOwn(step.with, "default")
    ) {
      continue;
    }
    return ` Step '${step.id}' is data.select@1 and supports with.default. Set that field to the fallback value requested by the user so the missing pointer succeeds deterministically; do not invent host null-coalescing or add an LLM for this fallback.`;
  }
  return "";
}

function normalizeCreatorOutput(
  draft: WorkflowDraftRecord,
  output: WorkflowCreatorOutput,
): WorkflowCreatorOutput {
  if (draft.revisionProtocol === "change-set-v1") {
    if (output.phase !== "draft") return output;
    if (output.mode !== "revise" || !output.changeSet || !draft.revisionBase) {
      throw new Error("revision creator must return mode 'revise' with one complete change set");
    }
    const candidate = applyWorkflowRevision(draft.revisionBase, output.changeSet);
    const semanticDiff = buildWorkflowSemanticDiff(draft.revisionBase, output.changeSet, candidate);
    if (semanticDiff.unattributedChanges.length > 0) {
      throw new Error(
        `revision produced unattributed changes: ${semanticDiff.unattributedChanges
          .map((change) => change.path)
          .join(", ")}`,
      );
    }
    const orderChanged = semanticDiff.changes.some((change) => change.path === "steps.order");
    const operationById = new Map(
      output.changeSet.operations.map((operation) => [operation.id, operation]),
    );
    const noOp = semanticDiff.operationCoverage
      .filter((coverage) => {
        if (coverage.changeIds.length > 0) return false;
        const operation = operationById.get(coverage.operationId);
        return !(operation?.op === "move-step" && orderChanged);
      })
      .map((coverage) => coverage.operationId);
    if (noOp.length > 0) {
      throw new Error(`revision operations produced no change: ${noOp.join(", ")}`);
    }
    draft.changeSet = output.changeSet;
    draft.semanticDiff = semanticDiff;
    return {
      ...output,
      manifest: candidate.manifest,
      resources: candidate.resources,
    };
  }
  const normalized = compileWorkflowCreation({
    output,
    name: draft.name,
    revision: draft.targetRevision ?? 1,
    baseManifest: draft.baseManifest,
    baseResources: draft.baseResources,
    request: revisionRequest(draft),
    protocol: draft.creationProtocol ?? "legacy-full-package",
  });
  if (!normalized.manifest) return normalized;
  if (draft.baseManifest && (draft.targetRevision ?? 1) > 1) {
    const legacyBase: WorkflowRevisionBase = {
      name: draft.baseManifest.name,
      scope: draft.scope,
      revision: draft.baseManifest.revision,
      packageHash: "legacy-unknown",
      executionHash: "legacy-unknown",
      manifest: draft.baseManifest,
      resources: draft.baseResources ?? [],
    };
    const candidate = {
      manifest: normalized.manifest!,
      resources: normalized.resources ?? [],
    };
    const legacyChangeSet = deriveLegacyWorkflowChangeSet(legacyBase, candidate);
    draft.semanticDiff = buildWorkflowSemanticDiff(legacyBase, legacyChangeSet, candidate);
  }
  return normalized;
}

function revisionRequest(draft: WorkflowDraftRecord): string {
  return (
    [...draft.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          !message.content.startsWith("[Host revision context]") &&
          !message.content.startsWith("[Host validation feedback]"),
      )?.content ?? ""
  );
}

function normalizedMarkdownSpacing(value: string): string {
  return value.replace(/\n{3,}/gu, "\n\n");
}

function reconcilePresentationWhitespace(
  content: string,
  manifest: WorkflowManifest,
  actualOutputs: JsonObject | undefined,
): string | undefined {
  const selected = manifest.presentation?.output;
  if (!selected || !actualOutputs) return undefined;
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length > 0) return undefined;
  const value = document.toJS() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const expect =
    record.expect && typeof record.expect === "object" && !Array.isArray(record.expect)
      ? (record.expect as Record<string, unknown>)
      : undefined;
  const expectedOutputs =
    expect?.outputs && typeof expect.outputs === "object" && !Array.isArray(expect.outputs)
      ? (expect.outputs as Record<string, JsonValue>)
      : undefined;
  const expected = expectedOutputs?.[selected];
  const actual = actualOutputs[selected];
  if (
    typeof expected !== "string" ||
    typeof actual !== "string" ||
    expected === actual ||
    normalizedMarkdownSpacing(expected) !== normalizedMarkdownSpacing(actual)
  ) {
    return undefined;
  }
  const reconciled = { ...expectedOutputs, [selected]: actual };
  if (JSON.stringify(reconciled) !== JSON.stringify(actualOutputs)) return undefined;
  expect!.outputs = reconciled;
  return `${JSON.stringify(record, null, 2)}\n`;
}

function creatorTestDiagnostics(
  pkg: ReturnType<typeof loadWorkflowPackage>,
): Array<{ path: string; message: string }> {
  const externalStepIds = pkg.manifest.steps
    .filter((step) => EXTERNAL_STEP_TYPES.has(step.uses))
    .map((step) => step.id);
  if (externalStepIds.length === 0) return [];

  const testFiles = pkg.files.filter((file) => /^tests\/.+\.ya?ml$/u.test(file.path));
  const diagnostics: Array<{ path: string; message: string }> = [];
  const completeCases: Array<ReturnType<typeof parseWorkflowTestCase>> = [];
  let inputValidator: ReturnType<WorkflowSchemaService["compile"]> | undefined;
  try {
    inputValidator = new WorkflowSchemaService().compile(pkg.manifest.inputs, "inputs");
  } catch {
    // Manifest validation reports the schema error; fixture diagnostics remain best-effort.
  }
  for (const file of testFiles) {
    try {
      const testCase = parseWorkflowTestCase(file.content, file.path);
      const preparedInputs = applyWorkflowInputDefaults(pkg.manifest.inputs, testCase.inputs);
      for (const issue of inputValidator?.validate(preparedInputs) ?? []) {
        diagnostics.push({
          path: file.path,
          message: `offline test inputs fail the workflow schema at ${issue.path}: ${issue.message}`,
        });
      }
      if (externalStepIds.every((stepId) => Object.hasOwn(testCase.mocks, stepId))) {
        completeCases.push(testCase);
      }
    } catch (error) {
      const message = (error as Error).message;
      const yamlParse = message.includes(" at line ")
        ? message.split("\n\n", 1)[0]!.slice(0, 500)
        : undefined;
      const schemaDetail = message.startsWith(`${file.path}: `)
        ? message.slice(file.path.length + 2, file.path.length + 502)
        : message.slice(0, 500);
      diagnostics.push({
        path: file.path,
        message: yamlParse
          ? `invalid offline test YAML/JSON: ${yamlParse}. Replace the entire resource content with one valid JSON object string; JSON is accepted for tests/*.yaml and avoids indentation errors`
          : `invalid offline test: ${schemaDetail}. Use only schema_version, name, mode, inputs, mocks, and expect at the root; mocks.<step-id> must contain output or error; expect.status is required`,
      });
    }
  }
  if (completeCases.length === 0) {
    diagnostics.push({
      path: "tests",
      message:
        "creator-generated workflows with HTTP, model, or command steps require an offline tests/*.yaml case; mocks.<step-id> must contain output or error and the case must mock every external step",
    });
  } else if (
    pkg.manifest.presentation &&
    !completeCases.some((testCase) =>
      Object.hasOwn(testCase.expect.outputs ?? {}, pkg.manifest.presentation!.output),
    )
  ) {
    diagnostics.push({
      path: "tests",
      message: `a successful offline test must assert expect.outputs.${pkg.manifest.presentation.output} so the selected presentation is exercised`,
    });
  }
  return diagnostics;
}

function creatorManifestDiagnostics(
  pkg: ReturnType<typeof loadWorkflowPackage>,
): Array<{ path: string; message: string }> {
  const diagnostics: Array<{ path: string; message: string }> = [];
  const reportImplicitOpenObjects = (schema: unknown, path: string): void => {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
    const record = schema as Record<string, unknown>;
    const objectTyped =
      record.type === "object" || (Array.isArray(record.type) && record.type.includes("object"));
    if (
      objectTyped &&
      !Object.hasOwn(record, "properties") &&
      !Object.hasOwn(record, "additionalProperties")
    ) {
      diagnostics.push({
        path,
        message:
          "creator-generated object schemas must declare their named properties or explicitly declare additionalProperties when intentionally free-form; preserve every object field the user named",
      });
    }
    if (
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
    ) {
      for (const [name, child] of Object.entries(record.properties)) {
        reportImplicitOpenObjects(child, `${path}.properties.${name}`);
      }
    }
    if (record.items) reportImplicitOpenObjects(record.items, `${path}.items`);
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      if (!Array.isArray(record[keyword])) continue;
      record[keyword].forEach((child, index) =>
        reportImplicitOpenObjects(child, `${path}.${keyword}.${index}`),
      );
    }
  };
  reportImplicitOpenObjects(pkg.manifest.inputs, "inputs");
  for (const access of ["read", "write"] as const) {
    if (pkg.manifest.permissions.filesystem?.[access]?.includes("/")) {
      diagnostics.push({
        path: `permissions.filesystem.${access}`,
        message:
          "creator-generated workflows must not request the entire filesystem root; use $project/** for the project tree or declare a narrower path",
      });
    }
  }
  const inputProperties =
    pkg.manifest.inputs.properties &&
    typeof pkg.manifest.inputs.properties === "object" &&
    !Array.isArray(pkg.manifest.inputs.properties)
      ? (pkg.manifest.inputs.properties as Record<string, Record<string, unknown>>)
      : {};
  const requiredInputs = Array.isArray(pkg.manifest.inputs.required)
    ? pkg.manifest.inputs.required
    : [];
  for (const name of requiredInputs) {
    if (typeof name !== "string") continue;
    const schema = inputProperties[name];
    if (
      schema?.type === "string" &&
      !(typeof schema.minLength === "number" && schema.minLength >= 1)
    ) {
      diagnostics.push({
        path: `inputs.properties.${name}`,
        message:
          "a required string input must declare minLength: 1 or greater so empty values are rejected explicitly",
      });
    }
  }
  for (const step of pkg.manifest.steps) {
    if (
      step.uses === "command.run@1" &&
      step.with &&
      typeof step.with === "object" &&
      !Array.isArray(step.with)
    ) {
      const args = Array.isArray(step.with.args) ? step.with.args : [];
      const packagedScript = args.find(
        (arg): arg is string =>
          typeof arg === "string" && /^(?:\.\/)?scripts\/.+\.(?:[cm]?[jt]s|tsx?)$/u.test(arg),
      );
      if (
        packagedScript &&
        (step.with.program !== "bun" ||
          args[0] !== "run" ||
          typeof args[1] !== "string" ||
          !args[1].startsWith("./scripts/"))
      ) {
        diagnostics.push({
          path: `steps.${step.id}.with.args`,
          message:
            "packaged JavaScript and TypeScript must use program: bun with args: [run, ./scripts/<name>]; declare the same command args_prefix",
        });
      }
    }
    if (
      step.uses === "llm.generate@1" &&
      step.with &&
      typeof step.with === "object" &&
      !Array.isArray(step.with) &&
      typeof step.with.prompt === "string"
    ) {
      reportImplicitOpenObjects(step.with.output_schema, `steps.${step.id}.with.output_schema`);
      const llmInput = step.with.input;
      const inputRecord =
        llmInput && typeof llmInput === "object" && !Array.isArray(llmInput) ? llmInput : undefined;
      for (const name of Object.keys(inputProperties)) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        if (!new RegExp(`\\b${escaped}\\b`, "u").test(step.with.prompt)) continue;
        const supplied =
          llmInput === "$inputs" ||
          llmInput === `$inputs.${name}` ||
          Boolean(inputRecord && Object.hasOwn(inputRecord, name));
        if (!supplied) {
          diagnostics.push({
            path: `steps.${step.id}.with.input`,
            message: `llm.generate prompt names top-level workflow input '${name}', but with.input does not pass it; pass an object containing ${name}: $inputs.${name} or remove behavior that depends on that input`,
          });
        }
      }
    }
    if (
      step.uses === "llm.generate@1" &&
      step.with &&
      typeof step.with === "object" &&
      !Array.isArray(step.with) &&
      typeof step.with.prompt === "string" &&
      (step.with.prompt.includes("{{") || /\$(?:\{)?inputs(?:\.|\b)/u.test(step.with.prompt))
    ) {
      diagnostics.push({
        path: `steps.${step.id}.with.prompt`,
        message:
          "llm.generate prompt is static and must not interpolate workflow inputs; pass runtime data through with.input and refer to its field names in prose",
      });
    }
    if (
      step.uses === "data.select@1" &&
      step.with &&
      typeof step.with === "object" &&
      !Array.isArray(step.with) &&
      typeof step.with.value === "string" &&
      step.with.value.endsWith(".output.body") &&
      step.with.pointer === "/"
    ) {
      diagnostics.push({
        path: `steps.${step.id}.with.pointer`,
        message:
          "JSON Pointer '/' selects a property named by the empty string; to select an HTTP body use value: $steps.<id>.output with pointer: /body, or use pointer: \"\" when value already references .output.body",
      });
    }
    if (step.uses !== "text.template@1") continue;
    const data =
      step.with &&
      typeof step.with === "object" &&
      !Array.isArray(step.with) &&
      step.with.data &&
      typeof step.with.data === "object" &&
      !Array.isArray(step.with.data)
        ? step.with.data
        : undefined;
    if (data && Object.values(data).some((value) => value === "$steps")) {
      diagnostics.push({
        path: `steps.${step.id}.with.data`,
        message:
          "text.template data cannot reference $steps as a whole; bind an exact earlier output such as plan: $steps.llm.output",
      });
    }
    const template =
      step.with &&
      typeof step.with === "object" &&
      !Array.isArray(step.with) &&
      typeof step.with.template === "string"
        ? step.with.template
        : undefined;
    if (!template) continue;
    if (/\{\{#each [A-Za-z0-9_./~-]+\}\}\r?\n/u.test(template)) {
      diagnostics.push({
        path: `steps.${step.id}.with.template`,
        message:
          "a newline immediately after {{#each ...}} becomes part of the repeated body and creates a blank line for every item; put the first repeated character directly after the opening tag, for example {{#each items}}- {{this}}\\n{{/each}}",
      });
    }
    if (/\{\{(?:inputs|steps)\./u.test(template)) {
      diagnostics.push({
        path: `steps.${step.id}.with.template`,
        message:
          "template expressions address keys bound in with.data, not workflow namespaces; bind title: $inputs.meeting.title and plan: $steps.llm.output, then use {{title}} and {{plan.summary}}",
      });
    }
    if (template.includes("||") || template.includes("??")) {
      diagnostics.push({
        path: `steps.${step.id}.with.template`,
        message:
          "text.template@1 does not support executable fallback expressions such as || or ??; use deterministic data/default steps or state the V1 limitation",
      });
    }
    if (/\$\{steps\./u.test(template)) {
      diagnostics.push({
        path: `steps.${step.id}.with.template`,
        message:
          "pass prior-step data through with.data using an exact $steps.<id>.output reference, then render fields with {{field}} syntax",
      });
    }
  }
  return diagnostics;
}

function creatorResourceDiagnostics(
  pkg: ReturnType<typeof loadWorkflowPackage>,
): Array<{ path: string; message: string }> {
  return pkg.files.flatMap((file) => {
    if (
      !/^scripts\/.+\.(?:[cm]?[jt]s|tsx?)$/u.test(file.path) ||
      !file.content.includes("path.extname(") ||
      !/\.(?:test|spec)\.[cm]?[jt]sx?/u.test(file.content) ||
      !/(?:test|spec)\.includes\(ext\)/u.test(file.content)
    ) {
      return [];
    }
    return [
      {
        path: file.path,
        message:
          "compound test suffixes such as .test.ts cannot be detected with path.extname(); classify the full lowercased filename with endsWith before counting the generic source extension",
      },
    ];
  });
}

function creatorFriendlyDiagnostics(
  diagnostics: Array<{ path: string; message: string }>,
): Array<{ path: string; message: string }> {
  return diagnostics.map((diagnostic) => {
    if (
      /^steps\.\d+\.with\/output$/u.test(diagnostic.path) &&
      diagnostic.message.includes("allowed values")
    ) {
      return {
        path: diagnostic.path,
        message:
          "command.run@1 with.output must be exactly 'text' or 'json', never 'stdout'; use 'json' when stdout is one JSON value",
      };
    }
    if (diagnostic.path !== "inputs" || !diagnostic.message.includes("unknown keyword")) {
      return diagnostic;
    }
    const keyword = /unknown keyword: "([^"]+)"/u.exec(diagnostic.message)?.[1];
    if (keyword && keyword.trim() !== keyword) {
      return {
        path: "inputs",
        message: `inputs contain JSON Schema keyword '${keyword}' with surrounding whitespace; use '${keyword.trim()}'`,
      };
    }
    return {
      path: "inputs",
      message: keyword
        ? `named workflow input '${keyword}' must be declared under inputs.properties; set inputs.type to object, list required names in inputs.required, and set inputs.additionalProperties explicitly`
        : "inputs must be JSON Schema: { type: object, properties: { <name>: <schema> }, required: [...], additionalProperties: false }",
    };
  });
}

export class WorkflowCreatorController {
  constructor(
    private readonly store: WorkflowDraftStore,
    private readonly model: WorkflowCreatorModel,
    private readonly playbook: string,
    private readonly steps:
      | WorkflowStepRegistry
      | ((packageDir: string, scope: "project" | "global") => WorkflowStepRegistry),
  ) {}

  start(input: {
    name?: string;
    scope?: "project" | "global";
    sessionId?: string;
    initialQuestions?: string[];
    initialMessages?: WorkflowDraftRecord["messages"];
    targetRevision?: number;
    revisionBase?: WorkflowRevisionBase;
    baseManifest?: WorkflowManifest;
    baseResources?: WorkflowCreatorResource[];
  }): WorkflowDraftRecord {
    const freshCreation =
      !input.revisionBase &&
      !input.baseManifest &&
      (input.targetRevision === undefined || input.targetRevision === 1);
    const draft = this.store.create({
      name: input.name,
      scope: input.scope ?? "project",
      sessionId: input.sessionId,
      targetRevision: input.targetRevision ?? 1,
      creationProtocol: freshCreation ? "blueprint-v1" : undefined,
      revisionProtocol: input.revisionBase ? "change-set-v1" : undefined,
      revisionBase: input.revisionBase,
      baseManifest: input.baseManifest,
      baseResources: input.baseResources,
    });
    if (input.initialMessages?.length) {
      draft.messages.push(...input.initialMessages);
      draft.requirementMessages?.push(...structuredClone(input.initialMessages));
    }
    if (input.initialQuestions?.length) {
      draft.output = {
        response: "Workflow requirements are still incomplete.",
        phase: "questions",
        assumptions: [],
        unresolvedQuestions: [...input.initialQuestions],
      };
      draft.requirementMessages?.push({
        role: "assistant",
        content: input.initialQuestions.join("\n"),
      });
      this.store.save(draft);
    }
    return draft;
  }

  private async writeAndValidateDraft(
    draft: WorkflowDraftRecord,
    output: WorkflowCreatorOutput,
  ): Promise<void> {
    if (!output.manifest) {
      draft.diagnostics.push({ path: "manifest", message: "draft response omitted manifest" });
      return;
    }
    try {
      const packageRoot = this.store.packageDir(draft.id);
      const packageDir = join(packageRoot, output.manifest.name);
      rmSync(packageRoot, { recursive: true, force: true });
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, "workflow.yaml"), stringify(output.manifest));
      for (const resource of output.resources ?? []) {
        const path = safeResource(resource);
        const target = join(packageDir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, resource.content);
      }
      writeFileSync(join(packageDir, "SKILL.md"), renderWorkflowSkillAdapter(output.manifest));
      const pkg = loadWorkflowPackage(packageDir, draft.scope);
      const steps =
        typeof this.steps === "function" ? this.steps(packageDir, draft.scope) : this.steps;
      const validation = validateWorkflowPackage(pkg, steps);
      draft.diagnostics = creatorFriendlyDiagnostics([
        ...revisionPolicyDiagnostics(draft, output),
        ...validation.issues,
        ...creatorManifestDiagnostics(pkg),
        ...creatorResourceDiagnostics(pkg),
        ...creatorTestDiagnostics(pkg),
      ]);
      if (draft.diagnostics.length === 0) {
        for (const file of pkg.files.filter((candidate) =>
          /^tests\/.+\.ya?ml$/u.test(candidate.path),
        )) {
          let testContent = file.content;
          let result = await runWorkflowTestCase(
            pkg,
            steps,
            parseWorkflowTestCase(testContent, file.path),
            { includeOutputs: true },
          );
          const reconciled = reconcilePresentationWhitespace(
            testContent,
            pkg.manifest,
            result.outputs,
          );
          if (reconciled) {
            testContent = reconciled;
            writeFileSync(join(packageDir, file.path), reconciled);
            const resource = output.resources?.find((candidate) => candidate.path === file.path);
            if (resource) resource.content = reconciled;
            const note = `Updated deterministic snapshot expectation in ${file.path} to match rendered presentation whitespace.`;
            output.compilerNotes = [...new Set([...(output.compilerNotes ?? []), note])];
            result = await runWorkflowTestCase(
              pkg,
              steps,
              parseWorkflowTestCase(testContent, file.path),
              { includeOutputs: true },
            );
          }
          if (!result.passed) {
            const hasLoopSpacingPattern = pkg.manifest.steps.some(
              (step) =>
                step.uses === "text.template@1" &&
                step.with &&
                typeof step.with === "object" &&
                !Array.isArray(step.with) &&
                typeof step.with.template === "string" &&
                step.with.template.includes("\n{{/each}}\n\n"),
            );
            const outputMismatch = result.failures.some((failure) =>
              failure.startsWith("final outputs did not match:"),
            );
            const spacingGuidance =
              hasLoopSpacingPattern && outputMismatch
                ? " The template loop body already ends with a newline; '{{/each}}\\n\\n' adds two more. To keep one blank line before the next section, change '{{/each}}\\n\\n##' to '{{/each}}\\n##', then make the exact test expectation match the rendered Markdown."
                : "";
            const fallbackGuidance = missingDataSelectFallbackGuidance(pkg, result.failures);
            draft.diagnostics.push({
              path: file.path,
              message: `offline test '${result.name}' failed: ${result.failures.join("; ")}${spacingGuidance}${fallbackGuidance}`,
            });
          }
        }
      }
      draft.name = pkg.name;
    } catch (error) {
      draft.diagnostics = [{ path: "package", message: (error as Error).message }];
    }
  }

  private async generate(
    draft: WorkflowDraftRecord,
    signal?: AbortSignal,
    allowValidationRepair = true,
  ): Promise<WorkflowDraftRecord> {
    draft.phase = "generating";
    draft.lastError = undefined;
    draft.attemptedResponses = undefined;
    this.store.save(draft);
    let output: Awaited<ReturnType<WorkflowCreatorModel["respond"]>>;
    try {
      output = await this.model.respond({
        playbook: this.playbook,
        messages: draft.messages,
        name: draft.name,
        scope: draft.scope,
        creationProtocol: draft.creationProtocol,
        requirementsContract: draft.requirementsContract,
        revisionBase: draft.revisionProtocol === "change-set-v1" ? draft.revisionBase : undefined,
        signal,
      });
    } catch (error) {
      const message = (error as Error).message.slice(0, 1_000);
      draft.phase = signal?.aborted ? "cancelled" : "failed";
      draft.lastError = message;
      draft.attemptedResponses = workflowCreatorAttemptedResponses(error);
      draft.diagnostics = [{ path: "creator", message }];
      this.store.save(draft);
      throw error;
    }
    if (output.requirementsContract) {
      draft.requirementsContract = output.requirementsContract;
    }
    try {
      output = normalizeCreatorOutput(draft, output);
    } catch (error) {
      draft.output = output;
      draft.phase = "draft";
      draft.diagnostics = [
        {
          path: draft.revisionProtocol === "change-set-v1" ? "changeSet" : "manifest",
          message: (error as Error).message,
        },
      ];
      if (draft.creationProtocol === "blueprint-v1") {
        resetBlueprintCandidate(draft, allowValidationRepair);
      } else {
        draft.messages.push({ role: "assistant", content: output.response });
        draft.messages.push({ role: "user", content: validationRepairMessage(draft) });
      }
      this.store.save(draft);
      if (allowValidationRepair) return this.generate(draft, signal, false);
      return draft;
    }
    const requirementTurn =
      output.phase === "questions" ||
      (output.phase === "draft" && output.unresolvedQuestions.length > 0);
    draft.messages.push({ role: "assistant", content: output.response });
    if (requirementTurn) {
      draft.requirementMessages?.push({ role: "assistant", content: output.response });
    }
    if (output.scope) draft.scope = output.scope;
    draft.output = output;
    draft.phase = output.phase;
    draft.diagnostics = [];
    if (output.phase === "draft" && output.unresolvedQuestions.length > 0) {
      draft.phase = "questions";
      this.store.save(draft);
      return draft;
    }
    if (output.phase === "draft") {
      await this.writeAndValidateDraft(draft, output);
    }
    if (draft.phase === "draft" && draft.diagnostics.length > 0) {
      if (draft.creationProtocol === "blueprint-v1") {
        resetBlueprintCandidate(draft, allowValidationRepair);
      } else {
        draft.messages.push({ role: "user", content: validationRepairMessage(draft) });
      }
      this.store.save(draft);
      if (allowValidationRepair) return this.generate(draft, signal, false);
    } else {
      this.store.save(draft);
    }
    return draft;
  }

  async respond(
    draftId: string,
    userMessage: string,
    signal?: AbortSignal,
  ): Promise<WorkflowDraftRecord> {
    const draft = this.store.get(draftId);
    if (!draft) throw new Error(`workflow draft '${draftId}' was not found`);
    draft.messages.push({ role: "user", content: userMessage });
    draft.requirementMessages?.push({ role: "user", content: userMessage });
    if (
      draft.creationProtocol === "blueprint-v1" &&
      draft.requirementsContract?.phase === "ready"
    ) {
      draft.requirementsContract = {
        ...draft.requirementsContract,
        phase: "questions",
      };
    }
    this.store.save(draft);
    return this.generate(draft, signal);
  }

  async retry(draftId: string, signal?: AbortSignal): Promise<WorkflowDraftRecord> {
    const draft = this.store.get(draftId);
    if (!draft) throw new Error(`workflow draft '${draftId}' was not found`);
    if (
      draft.phase === "questions" &&
      draft.output?.phase === "questions" &&
      draft.output.unresolvedQuestions.length > 0 &&
      draft.requirementsContract?.phase !== "ready"
    ) {
      // Retry repairs failed generation. It cannot answer a material
      // requirements question and must not spend another model call asking the
      // same thing or duplicate the assistant transcript.
      return draft;
    }
    if (
      draft.creationProtocol === "blueprint-v1" &&
      (draft.phase === "failed" || draft.phase === "cancelled" || draft.diagnostics.length > 0)
    ) {
      resetBlueprintCandidate(draft, true, blueprintRetryMessage(draft));
      draft.diagnostics = [];
      this.store.save(draft);
      return this.generate(draft, signal);
    }
    if (
      draft.output?.phase === "draft" &&
      (draft.phase === "failed" || draft.diagnostics.length > 0)
    ) {
      if (draft.revisionProtocol === "change-set-v1") {
        draft.messages = revisionRetryMessages(draft);
        draft.output = undefined;
        draft.changeSet = undefined;
        draft.semanticDiff = undefined;
        draft.lastError = undefined;
        draft.diagnostics = [];
        this.store.save(draft);
        return this.generate(draft, signal);
      }
      const normalized = normalizeCreatorOutput(draft, normalizeSafeStaticLlmInput(draft.output));
      draft.output = normalized;
      draft.phase = "draft";
      draft.lastError = undefined;
      draft.diagnostics = [];
      await this.writeAndValidateDraft(draft, normalized);
      if (draft.diagnostics.length === 0) {
        this.store.save(draft);
        return draft;
      }
      const feedback = validationRepairMessage(draft);
      const latest = draft.messages.at(-1);
      if (latest?.role !== "user" || latest.content !== feedback) {
        draft.messages.push({ role: "user", content: feedback });
      }
      this.store.save(draft);
    }
    return this.generate(draft, signal);
  }

  private hydrateRevisionDraft(
    draft: WorkflowDraftRecord | undefined,
  ): WorkflowDraftRecord | undefined {
    if (
      draft &&
      draft.revisionProtocol !== "change-set-v1" &&
      draft.baseManifest &&
      draft.output?.manifest &&
      (draft.targetRevision ?? 1) > 1
    ) {
      const legacyBase: WorkflowRevisionBase = {
        name: draft.baseManifest.name,
        scope: draft.scope,
        revision: draft.baseManifest.revision,
        packageHash: "legacy-unknown",
        executionHash: "legacy-unknown",
        manifest: draft.baseManifest,
        resources: draft.baseResources ?? [],
      };
      const candidate = {
        manifest: draft.output.manifest,
        resources: draft.output.resources ?? [],
      };
      draft.semanticDiff = buildWorkflowSemanticDiff(
        legacyBase,
        deriveLegacyWorkflowChangeSet(legacyBase, candidate),
        candidate,
      );
      return draft;
    }
    if (
      !draft ||
      draft.revisionProtocol !== "change-set-v1" ||
      !draft.revisionBase ||
      !draft.changeSet
    ) {
      return draft;
    }
    try {
      const candidate = applyWorkflowRevision(draft.revisionBase, draft.changeSet);
      draft.semanticDiff = buildWorkflowSemanticDiff(
        draft.revisionBase,
        draft.changeSet,
        candidate,
      );
      if (draft.output) {
        draft.output = {
          ...draft.output,
          mode: "revise",
          changeSet: draft.changeSet,
          manifest: candidate.manifest,
          resources: candidate.resources,
        };
      }
    } catch {
      // Persisted diagnostics remain the recovery source when materialization is invalid.
    }
    return draft;
  }

  get(id: string): WorkflowDraftRecord | undefined {
    return this.hydrateRevisionDraft(this.store.get(id));
  }

  latest(sessionId?: string): WorkflowDraftRecord | undefined {
    return this.hydrateRevisionDraft(this.store.latest(sessionId));
  }

  ensureRevisionBase(
    id: string,
    manifest: WorkflowManifest,
    resources: WorkflowCreatorResource[],
  ): WorkflowDraftRecord | undefined {
    const draft = this.store.get(id);
    if (!draft) return undefined;
    let changed = false;
    if (!draft.baseManifest) {
      draft.baseManifest = manifest;
      changed = true;
    }
    if (!draft.baseResources) {
      draft.baseResources = resources;
      changed = true;
    }
    if (changed) this.store.save(draft);
    return draft;
  }

  markActivated(id: string): void {
    const draft = this.store.get(id);
    if (!draft) return;
    draft.phase = "activated";
    draft.lastError = undefined;
    this.store.save(draft);
  }

  packageDir(draft: WorkflowDraftRecord): string {
    if (!draft.name) throw new Error("workflow draft does not have a name");
    return join(this.store.packageDir(draft.id), draft.name);
  }

  discard(id: string): void {
    this.store.discard(id);
  }
}
