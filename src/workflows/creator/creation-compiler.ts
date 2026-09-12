import type { WorkflowManifest } from "../parse";
import type { JsonSchema, JsonValue } from "../types";
import { deriveWorkflowCreationPermissions } from "./creation-permissions";
import { compileWorkflowCreatorValue } from "./creation-references";
import { canonicalizeWorkflowCreatorJsonSchema } from "./creation-schemas";
import { compileWorkflowCreatorSteps } from "./creation-steps";
import { compileWorkflowCreatorResources } from "./creation-tests";
import type { WorkflowCreatorOutput, WorkflowCreatorResource } from "./types";

function normalizeCreatorTemplateWhitespace(template: string): string {
  return template
    .replace(/\n\{\{\/each\}\}\n\n(?=#{1,6}(?: |\n|$))/gu, "\n{{/each}}\n")
    .replace(/\n\{\{\/each\}\}\n$/u, "\n{{/each}}");
}

function normalizeCreatorSecretInterpolation(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return value.replace(
      /\$\{\{\s*secrets\.([A-Za-z0-9_-]+)\s*\}\}/gu,
      (_whole, name: string) => `\${secrets.${name}}`,
    );
  }
  if (Array.isArray(value)) return value.map(normalizeCreatorSecretInterpolation);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeCreatorSecretInterpolation(child),
      ]),
    );
  }
  return value;
}

function normalizeCreatorLlmInput(
  step: WorkflowManifest["steps"][number],
  inputProperties: Record<string, unknown>,
): WorkflowManifest["steps"][number] {
  if (
    step.uses !== "llm.generate@1" ||
    !step.with ||
    typeof step.with !== "object" ||
    Array.isArray(step.with) ||
    typeof step.with.prompt !== "string" ||
    step.with.input === "$inputs"
  ) {
    return step;
  }
  const llmWith = step.with;
  const prompt = llmWith.prompt as string;
  const mentioned = Object.keys(inputProperties).filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "u").test(prompt);
  });
  if (mentioned.length === 0) return step;
  const current = llmWith.input;
  const canNormalize =
    current === null ||
    (typeof current === "string" && /^\$inputs\.[A-Za-z0-9_-]+$/u.test(current)) ||
    (current && typeof current === "object" && !Array.isArray(current));
  if (!canNormalize) return step;
  const bindings =
    current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  let changed = false;
  for (const name of mentioned) {
    if (Object.hasOwn(bindings, name)) continue;
    bindings[name] = `$inputs.${name}`;
    changed = true;
  }
  return changed ? { ...step, with: { ...llmWith, input: bindings } } : step;
}

function normalizeManifestSchemas(
  manifest: WorkflowManifest,
  protocol: "legacy-full-package" | "blueprint-v1",
): WorkflowManifest {
  const compiledSteps = compileWorkflowCreatorSteps(manifest.steps);
  const inputs =
    Object.keys(manifest.inputs).length === 0
      ? { type: "object", properties: {}, additionalProperties: false }
      : canonicalizeWorkflowCreatorJsonSchema(manifest.inputs);
  const inputProperties =
    inputs.properties && typeof inputs.properties === "object" && !Array.isArray(inputs.properties)
      ? (inputs.properties as Record<string, unknown>)
      : {};
  return {
    ...manifest,
    inputs,
    steps: compiledSteps.map((rawStep) => {
      const step =
        protocol === "legacy-full-package"
          ? normalizeCreatorLlmInput(rawStep, inputProperties)
          : rawStep;
      const normalizedStep = {
        ...step,
        with:
          protocol === "legacy-full-package"
            ? normalizeCreatorSecretInterpolation(step.with)
            : step.with,
      };
      if (
        !normalizedStep.with ||
        typeof normalizedStep.with !== "object" ||
        Array.isArray(normalizedStep.with)
      ) {
        return normalizedStep;
      }
      if (normalizedStep.uses === "llm.generate@1" && normalizedStep.with.output_schema) {
        return {
          ...normalizedStep,
          with: {
            ...normalizedStep.with,
            output_schema: canonicalizeWorkflowCreatorJsonSchema(
              normalizedStep.with.output_schema as JsonSchema,
            ) as JsonValue,
          },
        };
      }
      if (normalizedStep.uses === "assert.schema@1" && normalizedStep.with.schema) {
        return {
          ...normalizedStep,
          with: {
            ...normalizedStep.with,
            schema: canonicalizeWorkflowCreatorJsonSchema(
              normalizedStep.with.schema as JsonSchema,
            ) as JsonValue,
          },
        };
      }
      if (
        protocol === "legacy-full-package" &&
        normalizedStep.uses === "text.template@1" &&
        typeof normalizedStep.with.template === "string"
      ) {
        return {
          ...normalizedStep,
          with: {
            ...normalizedStep.with,
            template: normalizeCreatorTemplateWhitespace(normalizedStep.with.template),
          },
        };
      }
      return normalizedStep;
    }),
    outputs: Object.fromEntries(
      Object.entries(manifest.outputs).map(([name, declaration]) => [
        name,
        {
          ...declaration,
          schema: canonicalizeWorkflowCreatorJsonSchema(declaration.schema),
        },
      ]),
    ),
  };
}

function assertExactPackagedCommandResourcePaths(
  manifest: WorkflowManifest,
  resources: WorkflowCreatorResource[] | undefined,
): WorkflowManifest {
  const resourcePaths = new Set(
    resources?.map((resource) => resource.path.replaceAll("\\", "/")) ?? [],
  );
  for (const step of manifest.steps) {
    if (
      step.uses !== "command.run@1" ||
      !step.with ||
      typeof step.with !== "object" ||
      Array.isArray(step.with) ||
      !Array.isArray(step.with.args)
    ) {
      continue;
    }
    for (const arg of step.with.args) {
      if (typeof arg !== "string" || !/^(?:\.\/)?scripts\//u.test(arg)) continue;
      if (!arg.startsWith("./")) {
        throw new Error(
          `step '${step.id}' packaged script '${arg}' must use an exact './scripts/...' path`,
        );
      }
      const resourcePath = arg.slice(2);
      if (!resourcePaths.has(resourcePath)) {
        throw new Error(
          `step '${step.id}' packaged script '${arg}' does not match a declared resource`,
        );
      }
    }
  }
  return manifest;
}

function preserveUnrequestedExecutionTuning(
  base: WorkflowManifest | undefined,
  request: string,
  manifest: WorkflowManifest,
): WorkflowManifest {
  if (!base) return manifest;
  if (
    /\b(?:retr(?:y|ies)|backoff|timeout|deadline|provider|model|token|output cap|cancel(?:led|lation)?)\b/iu.test(
      request,
    )
  ) {
    return manifest;
  }
  const baseSteps = new Map(base.steps.map((step) => [step.id, step]));
  return {
    ...manifest,
    steps: manifest.steps.map((step) => {
      const original = baseSteps.get(step.id);
      if (!original || original.uses !== step.uses) return step;
      const { timeout: _generatedTimeout, retry: _generatedRetry, ...stepWithoutPolicy } = step;
      const preserved = {
        ...stepWithoutPolicy,
        ...(original.timeout === undefined ? {} : { timeout: original.timeout }),
        ...(original.retry === undefined ? {} : { retry: original.retry }),
      };
      if (
        step.uses !== "llm.generate@1" ||
        !step.with ||
        typeof step.with !== "object" ||
        Array.isArray(step.with)
      ) {
        return preserved;
      }
      const originalWith =
        original.with && typeof original.with === "object" && !Array.isArray(original.with)
          ? original.with
          : {};
      const {
        provider: _generatedProvider,
        model: _generatedModel,
        max_output_tokens: _generatedOutputCap,
        ...withWithoutPolicy
      } = step.with;
      const withPolicy = { ...withWithoutPolicy };
      for (const key of ["provider", "model", "max_output_tokens"] as const) {
        if (Object.hasOwn(originalWith, key)) withPolicy[key] = originalWith[key]!;
      }
      return { ...preserved, with: withPolicy };
    }),
  };
}

function mergeResources(
  base: WorkflowCreatorResource[] | undefined,
  generated: WorkflowCreatorResource[],
): WorkflowCreatorResource[] {
  if (!base?.length) return generated;
  const merged = new Map(base.map((resource) => [resource.path, resource]));
  for (const resource of generated) merged.set(resource.path, resource);
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export interface WorkflowCreationCompilerInput {
  output: WorkflowCreatorOutput;
  name?: string;
  revision: number;
  baseManifest?: WorkflowManifest;
  baseResources?: WorkflowCreatorResource[];
  request: string;
  protocol?: "legacy-full-package" | "blueprint-v1";
}

export function compileWorkflowCreation(
  input: WorkflowCreationCompilerInput,
): WorkflowCreatorOutput {
  const protocol = input.protocol ?? "legacy-full-package";
  const generatedManifest = input.output.manifest
    ? assertExactPackagedCommandResourcePaths(
        normalizeManifestSchemas(input.output.manifest, protocol),
        input.output.resources,
      )
    : undefined;
  const manifest = generatedManifest
    ? preserveUnrequestedExecutionTuning(input.baseManifest, input.request, generatedManifest)
    : undefined;
  const resources = mergeResources(
    input.baseResources,
    compileWorkflowCreatorResources(input.output.tests, input.output.resources, manifest, protocol),
  );
  if (!manifest) return { ...input.output, resources };
  const permissionResult = input.baseManifest
    ? { permissions: manifest.permissions, authority: undefined }
    : deriveWorkflowCreationPermissions(manifest);
  const outputs = Object.fromEntries(
    Object.entries(manifest.outputs).map(([name, declaration]) => [
      name,
      {
        ...declaration,
        value: compileWorkflowCreatorValue(declaration.value),
      },
    ]),
  );
  const packagedScripts =
    protocol === "blueprint-v1"
      ? resources
          .filter((resource) => /^scripts\/.+\.(?:[cm]?[jt]s|tsx?)$/u.test(resource.path))
          .map((resource) => resource.path)
      : [];
  const compilerNotes = [
    ...(input.output.compilerNotes ?? []),
    ...(packagedScripts.length > 0
      ? [
          `Offline command tests mock packaged script results and do not execute ${packagedScripts.join(", ")}; inspect the script and use allow once for its first live run.`,
        ]
      : []),
  ];
  return {
    ...input.output,
    resources,
    ...(permissionResult.authority ? { authority: permissionResult.authority } : {}),
    ...(compilerNotes.length > 0 ? { compilerNotes: [...new Set(compilerNotes)] } : {}),
    manifest: {
      ...manifest,
      name: input.name ?? manifest.name,
      revision: input.revision,
      permissions: permissionResult.permissions,
      outputs,
    },
  };
}
