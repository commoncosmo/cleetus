import { parseDocument } from "yaml";
import { applyWorkflowInputDefaults } from "../input-defaults";
import type { WorkflowManifest } from "../parse";
import { WorkflowSchemaService } from "../schema";
import { type WorkflowTestCase, parseWorkflowTestCase } from "../test-case";
import type { JsonSchema, JsonValue } from "../types";
import type { WorkflowCreatorMock, WorkflowCreatorResource, WorkflowCreatorTest } from "./types";

const errorSchema: JsonSchema = {
  type: "object",
  required: ["message"],
  properties: {
    message: { type: "string" },
    class: { type: "string" },
  },
  additionalProperties: false,
};

const mockErrorSchema: JsonSchema = {
  type: "object",
  required: ["step", "uses", "error"],
  properties: {
    step: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
    uses: { enum: ["http.request@1", "llm.generate@1", "command.run@1"] },
    error: errorSchema,
  },
  additionalProperties: false,
};

const mockSchema: JsonSchema = {
  oneOf: [
    {
      type: "object",
      required: ["step", "uses", "response"],
      properties: {
        step: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
        uses: { const: "http.request@1" },
        response: {
          type: "object",
          required: ["status", "content_type", "final_url", "body"],
          properties: {
            status: { type: "integer" },
            content_type: { type: "string" },
            final_url: { type: "string" },
            body: {},
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["step", "uses", "value"],
      properties: {
        step: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
        uses: { const: "llm.generate@1" },
        value: {},
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["step", "uses", "stdout"],
      properties: {
        step: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
        uses: { const: "command.run@1" },
        stdout: {},
        stderr: { type: "string" },
        exit_code: { type: "integer" },
        survivors: { type: "array", items: { type: "integer" } },
      },
      additionalProperties: false,
    },
    mockErrorSchema,
  ],
};

const testCaseSchema: JsonSchema = {
  type: "object",
  required: ["schema_version", "name", "inputs", "mocks", "expect"],
  properties: {
    schema_version: { const: 1 },
    name: { type: "string", minLength: 1 },
    mode: { const: "mock" },
    inputs: { type: "object" },
    mocks: {
      type: "array",
      items: mockSchema,
    },
    expect: {
      type: "object",
      required: ["status"],
      properties: {
        status: { enum: ["succeeded", "failed", "cancelled"] },
        outputs: { type: "object" },
        failed_step: { type: "string" },
        attempts: {
          type: "object",
          additionalProperties: { type: "integer", minimum: 0 },
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const WORKFLOW_CREATOR_TESTS_SCHEMA: JsonSchema = {
  type: "array",
  items: {
    type: "object",
    required: ["path", "case"],
    properties: {
      path: {
        type: "string",
        pattern: "^tests/[A-Za-z0-9._/-]+\\.ya?ml$",
      },
      case: testCaseSchema,
    },
    additionalProperties: false,
  },
};

function runtimeMock(mock: WorkflowCreatorMock): {
  step: string;
  value: WorkflowTestCase["mocks"][string];
} {
  if ("error" in mock) {
    return {
      step: mock.step,
      value: {
        error: {
          message: mock.error.message,
          class: mock.error.class ?? "executor_error",
        },
      },
    };
  }
  if (mock.uses === "http.request@1") {
    return { step: mock.step, value: { output: mock.response } };
  }
  if (mock.uses === "llm.generate@1") {
    return { step: mock.step, value: { output: mock.value } };
  }
  return {
    step: mock.step,
    value: {
      output: {
        stdout: mock.stdout,
        stderr: mock.stderr ?? "",
        exit_code: mock.exit_code ?? 0,
        survivors: mock.survivors ?? [],
      },
    },
  };
}

function canonicalTestCase(
  test: WorkflowCreatorTest,
  manifest?: WorkflowManifest,
): WorkflowTestCase {
  const stepTypes = new Map(manifest?.steps.map((step) => [step.id, step.uses]) ?? []);
  const mocks: WorkflowTestCase["mocks"] = {};
  for (const mock of test.case.mocks) {
    if (Object.hasOwn(mocks, mock.step)) {
      throw new Error(`${test.path}: duplicate mock for step '${mock.step}'`);
    }
    const actual = stepTypes.get(mock.step);
    if (manifest && !actual) {
      throw new Error(`${test.path}: mock references unknown step '${mock.step}'`);
    }
    if (actual && actual !== mock.uses) {
      throw new Error(
        `${test.path}: mock for step '${mock.step}' declares ${mock.uses}, expected ${actual}`,
      );
    }
    const compiled = runtimeMock(mock);
    mocks[compiled.step] = compiled.value;
  }
  if (manifest && test.case.expect.status === "succeeded") {
    const external = manifest.steps
      .filter((step) => ["http.request@1", "llm.generate@1", "command.run@1"].includes(step.uses))
      .map((step) => step.id);
    const missing = external.filter((step) => !Object.hasOwn(mocks, step));
    if (missing.length > 0) {
      throw new Error(
        `${test.path}: successful case must mock every external step; missing ${missing.join(", ")}`,
      );
    }
  }
  let inputs = test.case.inputs;
  if (manifest) {
    inputs = applyWorkflowInputDefaults(manifest.inputs, inputs) as WorkflowTestCase["inputs"];
    const issues = new WorkflowSchemaService().compile(manifest.inputs, "inputs").validate(inputs);
    if (issues.length > 0) {
      throw new Error(
        `${test.path}: inputs must provide required values without defaults: ${issues
          .slice(0, 6)
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    for (const output of Object.keys(test.case.expect.outputs ?? {})) {
      if (!Object.hasOwn(manifest.outputs, output)) {
        throw new Error(`${test.path}: expectation references unknown output '${output}'`);
      }
    }
  }
  const runtimeCase = { ...test.case, inputs, mocks };
  const content = `${JSON.stringify(runtimeCase, null, 2)}\n`;
  return parseWorkflowTestCase(content, test.path);
}

export function compileWorkflowCreatorTests(
  tests: readonly WorkflowCreatorTest[] | undefined,
  resources: readonly WorkflowCreatorResource[] | undefined,
  manifest?: WorkflowManifest,
): WorkflowCreatorResource[] {
  const output = [...(resources ?? [])];
  const paths = new Set(output.map((resource) => resource.path.replaceAll("\\", "/")));
  for (const test of tests ?? []) {
    const path = test.path.replaceAll("\\", "/");
    if (!/^tests\/[A-Za-z0-9._/-]+\.ya?ml$/u.test(path) || path.includes("../")) {
      throw new Error(`unsafe structured workflow test path '${test.path}'`);
    }
    if (paths.has(path)) {
      throw new Error(`duplicate workflow resource path '${path}'`);
    }
    paths.add(path);
    output.push({
      path,
      content: `${JSON.stringify(canonicalTestCase({ ...test, path }, manifest), null, 2)}\n`,
    });
  }
  return output;
}

function normalizeUnindentedPresentationBlock(
  content: string,
  presentationOutput: string | undefined,
): string {
  if (!presentationOutput) return content;
  const escaped = presentationOutput.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const marker = new RegExp(`^ {4}${escaped}:\\s*\\|[+-]?\\s*$`, "u");
  const lines = content.split("\n");
  const markerIndex = lines.findIndex((line, index) => {
    if (!marker.test(line)) return false;
    return (
      lines.slice(0, index).some((candidate) => candidate === "expect:") &&
      lines.slice(0, index).some((candidate) => candidate === "  outputs:")
    );
  });
  if (markerIndex < 0) return content;
  const firstContent = lines
    .slice(markerIndex + 1)
    .find((line) => line.trim().length > 0 && !/^ {2}(?:attempts|failed_step):/u.test(line));
  if (!firstContent || firstContent.length - firstContent.trimStart().length >= 6) return content;
  for (let index = markerIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^ {2}(?:attempts|failed_step):/u.test(line)) break;
    if (line.trim().length === 0) continue;
    const indentation = line.length - line.trimStart().length;
    if (indentation < 6) lines[index] = `${" ".repeat(6 - indentation)}${line}`;
  }
  return lines.join("\n");
}

function presentationTemplateCannotEndWithNewline(manifest: WorkflowManifest | undefined): boolean {
  const selected = manifest?.presentation?.output;
  const value = selected ? manifest?.outputs[selected]?.value : undefined;
  if (typeof value !== "string") return false;
  const reference = /^\$steps\.([a-z0-9]+(?:-[a-z0-9]+)*)\.output$/u.exec(value);
  const step = reference
    ? manifest?.steps.find((candidate) => candidate.id === reference[1])
    : undefined;
  const template =
    step?.uses === "text.template@1" &&
    step.with &&
    typeof step.with === "object" &&
    !Array.isArray(step.with) &&
    typeof step.with.template === "string"
      ? step.with.template
      : undefined;
  if (!template || template.endsWith("\n")) return false;
  if (!template.endsWith("{{/each}}")) {
    return !/\{\{(?:this(?:\.[A-Za-z0-9_./~-]+)?|[A-Za-z0-9_./~-]+)\}\}$/u.test(template);
  }
  const close = template.length - "{{/each}}".length;
  const open = template.lastIndexOf("{{#each ", close);
  const bodyStart = open >= 0 ? template.indexOf("}}", open) + 2 : -1;
  if (open < 0 || bodyStart < 2) return false;
  const body = template.slice(bodyStart, close);
  return (
    !body.endsWith("\n") &&
    !/\{\{(?:this(?:\.[A-Za-z0-9_./~-]+)?|[A-Za-z0-9_./~-]+)\}\}$/u.test(body)
  );
}

function normalizeExpectedTemplateSpacing(
  expected: string,
  manifest: WorkflowManifest | undefined,
): string {
  const selected = manifest?.presentation?.output;
  const value = selected ? manifest?.outputs[selected]?.value : undefined;
  if (typeof value !== "string") return expected;
  const reference = /^\$steps\.([a-z0-9]+(?:-[a-z0-9]+)*)\.output$/u.exec(value);
  const step = reference
    ? manifest?.steps.find((candidate) => candidate.id === reference[1])
    : undefined;
  const template =
    step?.uses === "text.template@1" &&
    step.with &&
    typeof step.with === "object" &&
    !Array.isArray(step.with) &&
    typeof step.with.template === "string"
      ? step.with.template
      : undefined;
  if (!template) return expected;
  let normalized = expected;
  for (const match of template.matchAll(/\{\{\/each\}\}\n(#{1,6} [^\n]+)/gu)) {
    const heading = match[1]!;
    if (normalized.includes(`\n\n${heading}`)) continue;
    normalized = normalized.replace(`\n${heading}`, `\n\n${heading}`);
  }
  return normalized;
}

const NO_SCHEMA_SAMPLE = Symbol("no-schema-sample");

function schemaSample(schema: unknown): JsonValue | typeof NO_SCHEMA_SAMPLE {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return NO_SCHEMA_SAMPLE;
  const record = schema as Record<string, unknown>;
  for (const keyword of ["default", "const"] as const) {
    if (Object.hasOwn(record, keyword)) return record[keyword] as JsonValue;
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) return record.enum[0] as JsonValue;
  const type = Array.isArray(record.type)
    ? record.type.find((candidate) => candidate !== "null")
    : record.type;
  if (type === "string") {
    const minimum =
      typeof record.minLength === "number" && Number.isInteger(record.minLength)
        ? Math.max(0, record.minLength)
        : 0;
    return "example".padEnd(minimum, "x");
  }
  if (type === "integer" || type === "number") {
    const minimum = typeof record.minimum === "number" ? record.minimum : 0;
    const exclusive =
      typeof record.exclusiveMinimum === "number" ? record.exclusiveMinimum : undefined;
    const value = exclusive === undefined ? Math.max(0, minimum) : Math.max(0, exclusive + 1);
    return type === "integer" ? Math.ceil(value) : value;
  }
  if (type === "boolean") return false;
  if (type === "null") return null;
  if (type === "array") {
    const minimum =
      typeof record.minItems === "number" && Number.isInteger(record.minItems)
        ? Math.max(0, record.minItems)
        : 0;
    const item = minimum > 0 ? schemaSample(record.items) : null;
    if (minimum > 0 && item === NO_SCHEMA_SAMPLE) return NO_SCHEMA_SAMPLE;
    return Array.from({ length: minimum }, () => item as JsonValue);
  }
  if (type === "object") {
    const properties =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    const value: Record<string, JsonValue> = {};
    for (const name of Array.isArray(record.required) ? record.required : []) {
      if (typeof name !== "string") continue;
      const child = schemaSample(properties[name]);
      if (child === NO_SCHEMA_SAMPLE) return NO_SCHEMA_SAMPLE;
      value[name] = child;
    }
    return value;
  }
  return NO_SCHEMA_SAMPLE;
}

function normalizeCreatorTestInputs(
  inputs: unknown,
  manifest: WorkflowManifest | undefined,
): JsonValue | undefined {
  if (
    !manifest ||
    !inputs ||
    typeof inputs !== "object" ||
    Array.isArray(inputs) ||
    !Array.isArray(manifest.inputs.required)
  ) {
    return undefined;
  }
  const properties =
    manifest.inputs.properties &&
    typeof manifest.inputs.properties === "object" &&
    !Array.isArray(manifest.inputs.properties)
      ? (manifest.inputs.properties as Record<string, unknown>)
      : {};
  const normalized = { ...(inputs as Record<string, JsonValue>) };
  let changed = false;
  for (const name of manifest.inputs.required) {
    if (typeof name !== "string" || Object.hasOwn(normalized, name)) continue;
    const sample = schemaSample(properties[name]);
    if (sample === NO_SCHEMA_SAMPLE) return undefined;
    normalized[name] = sample;
    changed = true;
  }
  if (!changed) return undefined;
  try {
    const validator = new WorkflowSchemaService().compile(manifest.inputs, "inputs");
    const prepared = applyWorkflowInputDefaults(manifest.inputs, normalized);
    return validator.validate(prepared).length === 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTestResource(
  resource: WorkflowCreatorResource,
  manifest?: WorkflowManifest,
): WorkflowCreatorResource {
  if (!/^tests\/.+\.ya?ml$/u.test(resource.path)) return resource;
  const content = normalizeUnindentedPresentationBlock(
    resource.content,
    manifest?.presentation?.output,
  );
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length > 0)
    return content === resource.content ? resource : { ...resource, content };
  const value = document.toJS() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return content === resource.content ? resource : { ...resource, content };
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  const normalizedInputs = normalizeCreatorTestInputs(record.inputs, manifest);
  if (normalizedInputs !== undefined) {
    record.inputs = normalizedInputs;
    changed = true;
  }
  const expect =
    record.expect && typeof record.expect === "object" && !Array.isArray(record.expect)
      ? (record.expect as Record<string, unknown>)
      : undefined;
  const expectedOutputs =
    expect?.outputs && typeof expect.outputs === "object" && !Array.isArray(expect.outputs)
      ? (expect.outputs as Record<string, unknown>)
      : undefined;
  const presentationOutput = manifest?.presentation?.output;
  const expectedPresentation = presentationOutput
    ? expectedOutputs?.[presentationOutput]
    : undefined;
  if (presentationOutput && typeof expectedPresentation === "string") {
    const normalizedExpected = normalizeExpectedTemplateSpacing(expectedPresentation, manifest);
    if (normalizedExpected !== expectedPresentation) {
      expectedOutputs![presentationOutput] = normalizedExpected;
      changed = true;
    }
  }
  const spacedExpectedPresentation = presentationOutput
    ? expectedOutputs?.[presentationOutput]
    : undefined;
  if (
    presentationOutput &&
    typeof spacedExpectedPresentation === "string" &&
    spacedExpectedPresentation.endsWith("\n") &&
    !spacedExpectedPresentation.endsWith("\n\n") &&
    presentationTemplateCannotEndWithNewline(manifest)
  ) {
    expectedOutputs![presentationOutput] = spacedExpectedPresentation.slice(0, -1);
    changed = true;
  }
  const mocks = record.mocks;
  if (!mocks || typeof mocks !== "object" || Array.isArray(mocks)) {
    return changed
      ? { ...resource, content: `${JSON.stringify(record, null, 2)}\n` }
      : content === resource.content
        ? resource
        : { ...resource, content };
  }
  const normalizedMocks: Record<string, unknown> = {};
  const stepTypes = new Map(manifest?.steps.map((step) => [step.id, step.uses]) ?? []);
  const stepsById = new Map(manifest?.steps.map((step) => [step.id, step]) ?? []);
  for (const [stepId, mock] of Object.entries(mocks)) {
    let normalizedMock = mock;
    if (
      mock &&
      typeof mock === "object" &&
      !Array.isArray(mock) &&
      !Object.hasOwn(mock, "output") &&
      !Object.hasOwn(mock, "error")
    ) {
      const fields = mock as Record<string, unknown>;
      normalizedMock =
        Object.keys(fields).length === 1 && Object.hasOwn(fields, "response")
          ? { output: fields.response }
          : { output: fields };
      changed = true;
    }

    const fields =
      normalizedMock && typeof normalizedMock === "object" && !Array.isArray(normalizedMock)
        ? (normalizedMock as Record<string, unknown>)
        : null;
    const output =
      fields?.output && typeof fields.output === "object" && !Array.isArray(fields.output)
        ? (fields.output as Record<string, unknown>)
        : undefined;
    if (
      stepTypes.get(stepId) === "llm.generate@1" &&
      output?.status === "succeeded" &&
      Object.hasOwn(output, "output") &&
      Object.keys(output).every((key) => key === "status" || key === "output")
    ) {
      normalizedMock = { ...fields, output: output.output };
      changed = true;
    } else if (stepTypes.get(stepId) === "command.run@1" && output) {
      let normalizedOutput = { ...output };
      let commandChanged = false;
      if (normalizedOutput.status === "succeeded") {
        const { status: _status, ...withoutStatus } = normalizedOutput;
        normalizedOutput = withoutStatus;
        commandChanged = true;
      }
      if (!Object.hasOwn(normalizedOutput, "survivors")) {
        normalizedOutput.survivors = [];
        commandChanged = true;
      }
      const step = stepsById.get(stepId);
      const jsonOutput =
        step?.with &&
        typeof step.with === "object" &&
        !Array.isArray(step.with) &&
        step.with.output === "json";
      if (jsonOutput && typeof normalizedOutput.stdout === "string") {
        try {
          normalizedOutput.stdout = JSON.parse(normalizedOutput.stdout);
          commandChanged = true;
        } catch {
          // Leave malformed JSON visible to the offline executor and its diagnostics.
        }
      }
      if (commandChanged) {
        normalizedMock = { ...fields, output: normalizedOutput };
        changed = true;
      }
    }
    normalizedMocks[stepId] = normalizedMock;
  }
  return {
    ...resource,
    content: `${JSON.stringify(changed ? { ...record, mocks: normalizedMocks } : record, null, 2)}\n`,
  };
}

export function compileWorkflowCreatorResources(
  tests: readonly WorkflowCreatorTest[] | undefined,
  resources: readonly WorkflowCreatorResource[] | undefined,
  manifest: WorkflowManifest | undefined,
  protocol: "legacy-full-package" | "blueprint-v1" = "legacy-full-package",
): WorkflowCreatorResource[] {
  if (protocol === "blueprint-v1") {
    const legacyTest = resources?.find((resource) => /^tests\/.+\.ya?ml$/u.test(resource.path));
    if (legacyTest) {
      throw new Error(
        `blueprint-v1 must declare '${legacyTest.path}' through the structured tests field, not resources`,
      );
    }
    return compileWorkflowCreatorTests(tests, resources, manifest);
  }
  return compileWorkflowCreatorTests(tests, resources, manifest).map((resource) =>
    normalizeTestResource(resource, manifest),
  );
}
