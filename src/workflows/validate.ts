import { parseWorkflowDuration } from "./duration";
import { schemaCanProduceDefault } from "./input-defaults";
import type { WorkflowPackage } from "./package";
import { normalizeWorkflowPermissions, workflowPermissionsContain } from "./permissions";
import type { PlannedWorkflowStep, WorkflowExecutionPlan } from "./plan";
import { workflowReferencesIn } from "./references";
import { type CompiledWorkflowSchema, WorkflowSchemaService } from "./schema";
import type { WorkflowStepRegistry } from "./step-registry";
import type {
  JsonSchema,
  JsonValue,
  WorkflowPermissions,
  WorkflowRetryPolicy,
  WorkflowValidationIssue,
} from "./types";

function hasReference(value: JsonValue): boolean {
  return workflowReferencesIn(value).length > 0;
}

function hasUnsupportedTemplateSyntax(value: JsonValue): boolean {
  if (typeof value === "string") return value.includes("{{") || value.includes("}}");
  if (Array.isArray(value)) return value.some(hasUnsupportedTemplateSyntax);
  if (value && typeof value === "object") {
    return Object.values(value).some(hasUnsupportedTemplateSyntax);
  }
  return false;
}

function missingInputReferenceSegment(schema: JsonSchema, path: string[]): string | undefined {
  let current = schema;
  const selected: string[] = [];
  for (const segment of path) {
    selected.push(segment);
    if (current.type === "array") {
      const index = /^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : undefined;
      const minimum = typeof current.minItems === "number" ? current.minItems : 0;
      if (index === undefined || index >= minimum) return selected.join(".");
      if (!current.items || typeof current.items !== "object" || Array.isArray(current.items)) {
        return selected.join(".");
      }
      current = current.items as JsonSchema;
      continue;
    }
    const properties =
      current.properties &&
      typeof current.properties === "object" &&
      !Array.isArray(current.properties)
        ? (current.properties as Record<string, JsonSchema>)
        : {};
    const child = properties[segment];
    if (!child) return selected.join(".");
    const required = new Set(
      Array.isArray(current.required)
        ? current.required.filter((name): name is string => typeof name === "string")
        : [],
    );
    if (!required.has(segment) && !schemaCanProduceDefault(child)) {
      return selected.join(".");
    }
    current = child;
  }
  return undefined;
}

function validateInputReference(
  ref: { namespace: string; path: string[] },
  manifestInputs: JsonSchema,
  issuePath: string,
  issues: WorkflowValidationIssue[],
): void {
  if (ref.namespace !== "inputs" || ref.path.length === 0) return;
  const missing = missingInputReferenceSegment(manifestInputs, ref.path);
  if (!missing) return;
  issues.push({
    path: issuePath,
    message: `input reference '$inputs.${ref.path.join(".")}' can be missing at '${missing}'; make that input path required or declare a default that materializes it`,
  });
}

function validateReferenceBearingInput(
  schema: JsonSchema,
  value: JsonValue,
  schemas: WorkflowSchemaService,
): WorkflowValidationIssue[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const definition = schema;
  const properties =
    definition.properties &&
    typeof definition.properties === "object" &&
    !Array.isArray(definition.properties)
      ? (definition.properties as Record<string, JsonSchema>)
      : {};
  const issues: WorkflowValidationIssue[] = [];
  const required = Array.isArray(definition.required)
    ? definition.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const name of required) {
    if (!Object.hasOwn(value, name)) {
      issues.push({ path: "/", message: `must have required property '${name}'` });
    }
  }
  if (definition.additionalProperties === false) {
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(properties, name)) {
        issues.push({ path: `/${name}`, message: "must NOT have additional properties" });
      }
    }
  }
  for (const [name, child] of Object.entries(value)) {
    const propertySchema = properties[name];
    if (!propertySchema || hasReference(child)) continue;
    for (const issue of schemas.compile(propertySchema, `property '${name}'`).validate(child)) {
      issues.push({
        ...issue,
        path: `/${name}${issue.path === "/" ? "" : issue.path}`,
      });
    }
  }
  return issues;
}

function emptyPermissions(): WorkflowPermissions {
  return {
    network: [],
    commands: [],
    filesystem: { read: [], write: [] },
    model: false,
  };
}

function normalizedPermissions(pkg: WorkflowPackage): WorkflowPermissions {
  const raw = pkg.manifest.permissions;
  return normalizeWorkflowPermissions({
    network: (raw.network ?? []).map((entry) => ({
      host: entry.host.toLowerCase(),
      methods: [...new Set(entry.methods.map((method) => method.toUpperCase()))].sort(),
    })),
    commands: (raw.commands ?? []).map((entry) => ({
      program: entry.program,
      argsPrefix: entry.args_prefix,
    })),
    filesystem: {
      read: [...(raw.filesystem?.read ?? [])],
      write: [...(raw.filesystem?.write ?? [])],
    },
    model: raw.model ?? false,
  });
}

function normalizeRetry(step: WorkflowPackage["manifest"]["steps"][number]): WorkflowRetryPolicy {
  if (!step.retry) {
    return {
      attempts: 0,
      backoff: { initialMs: 100, multiplier: 2, maximumMs: 5_000 },
      when: [],
    };
  }
  return {
    attempts: step.retry.attempts,
    backoff: {
      initialMs: parseWorkflowDuration(step.retry.backoff.initial, `${step.id}.retry.initial`),
      multiplier: step.retry.backoff.multiplier,
      maximumMs: parseWorkflowDuration(step.retry.backoff.maximum, `${step.id}.retry.maximum`),
    },
    when: [...step.retry.when],
  };
}

const EXACT_STEP_OUTPUT_REFERENCE =
  /^\$steps\.([A-Za-z0-9_-]+)\.output(?:\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))?$/u;

function pointerSegments(pointer: string): string[] | undefined {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?![01])/u.test(encoded)) return undefined;
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (["__proto__", "prototype", "constructor"].includes(segment)) return undefined;
    segments.push(segment);
  }
  return segments;
}

function schemaCanContainPath(schema: JsonSchema, path: string[]): boolean {
  if (path.length === 0) return true;
  if (schema.anyOf || schema.oneOf || schema.allOf || schema.$ref) return true;
  const [head, ...rest] = path;
  const type = schema.type;
  if (type === "object" || schema.properties) {
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, JsonSchema>)
        : {};
    if (Object.hasOwn(properties, head!)) {
      return schemaCanContainPath(properties[head!]!, rest);
    }
    if (schema.additionalProperties === false) return false;
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      return schemaCanContainPath(schema.additionalProperties as JsonSchema, rest);
    }
    return true;
  }
  if (type === "array") {
    if (!/^(?:0|[1-9]\d*)$/u.test(head!)) return false;
    return schema.items && typeof schema.items === "object"
      ? schemaCanContainPath(schema.items as JsonSchema, rest)
      : true;
  }
  if (["null", "boolean", "integer", "number", "string"].includes(String(type))) return false;
  return true;
}

function effectiveStepOutputSchema(
  step: WorkflowPackage["manifest"]["steps"][number],
  fallback: JsonSchema,
): JsonSchema {
  if (!step.with || typeof step.with !== "object" || Array.isArray(step.with)) return fallback;
  if (
    step.uses === "llm.generate@1" &&
    step.with.output_schema &&
    typeof step.with.output_schema === "object" &&
    !Array.isArray(step.with.output_schema)
  ) {
    return step.with.output_schema as JsonSchema;
  }
  if (
    step.uses === "assert.schema@1" &&
    step.with.schema &&
    typeof step.with.schema === "object" &&
    !Array.isArray(step.with.schema)
  ) {
    return step.with.schema as JsonSchema;
  }
  return fallback;
}

function validateKnownStepOutputReferences(
  value: JsonValue,
  issuePath: string,
  outputSchemas: Map<string, JsonSchema>,
  issues: WorkflowValidationIssue[],
): void {
  for (const reference of workflowReferencesIn(value)) {
    if (reference.namespace !== "steps") continue;
    const [stepId, marker, ...path] = reference.path;
    if (!stepId || marker !== "output") continue;
    const schema = outputSchemas.get(stepId);
    if (!schema || schemaCanContainPath(schema, path)) continue;
    issues.push({
      path: issuePath,
      message: `$steps.${stepId}.output does not contain '${path.join(
        ".",
      )}' according to the declared output schema; use the whole step result when path is empty`,
    });
  }
}

function validateDataSelectPointer(
  step: WorkflowPackage["manifest"]["steps"][number],
  ordinal: number,
  outputSchemas: Map<string, JsonSchema>,
  issues: WorkflowValidationIssue[],
): void {
  if (step.uses !== "data.select@1" || !step.with || typeof step.with !== "object") return;
  const input = step.with as Record<string, JsonValue>;
  if (typeof input.value !== "string" || typeof input.pointer !== "string") return;
  const match = EXACT_STEP_OUTPUT_REFERENCE.exec(input.value);
  if (!match) return;
  const upstream = outputSchemas.get(match[1]!);
  const selected = pointerSegments(input.pointer);
  if (!upstream || !selected) return;
  const referencePath = match[2]?.split(".") ?? [];
  if (!schemaCanContainPath(upstream, [...referencePath, ...selected])) {
    issues.push({
      path: `steps.${ordinal}.with.pointer`,
      message: `JSON Pointer '${input.pointer}' cannot match the known output schema for step '${match[1]}'; HTTP response payloads are under output.body`,
    });
  }
}

function validateReferences(pkg: WorkflowPackage, issues: WorkflowValidationIssue[]): void {
  const earlier = new Set<string>();
  const declaredSecrets = new Set(Object.keys(pkg.manifest.secrets ?? {}));
  for (const step of pkg.manifest.steps) {
    if (step.uses !== "text.template@1" && hasUnsupportedTemplateSyntax(step.with)) {
      issues.push({
        path: `steps.${step.id}.with`,
        message:
          "unsupported '{{...}}' syntax; use whole-value $steps.<earlier-id>.output references or scalar ${...} interpolation",
      });
    }
    for (const ref of workflowReferencesIn(step.with)) {
      validateInputReference(ref, pkg.manifest.inputs, `steps.${step.id}.with`, issues);
      if (ref.namespace === "steps") {
        const [id, output] = ref.path;
        if (!id || output !== "output") {
          issues.push({
            path: `steps.${step.id}.with`,
            message: "step references must use $steps.<earlier-id>.output",
          });
        } else if (!earlier.has(id)) {
          issues.push({
            path: `steps.${step.id}.with`,
            message: `step '${id}' is not an available earlier step`,
          });
        }
      }
      if (ref.namespace === "secrets") {
        const [name] = ref.path;
        if (!name || !declaredSecrets.has(name)) {
          issues.push({
            path: `steps.${step.id}.with`,
            message: `secret '${name ?? ""}' is not declared`,
          });
        }
      }
      if (ref.namespace === "run") {
        const supported = ["id", "started_at", "workspace"];
        if (ref.path.length !== 1 || !supported.includes(ref.path[0]!)) {
          issues.push({
            path: `steps.${step.id}.with`,
            message: `unsupported run reference '${ref.path.join(".")}'`,
          });
        }
      }
    }
    earlier.add(step.id);
  }
  for (const [name, output] of Object.entries(pkg.manifest.outputs)) {
    if (hasUnsupportedTemplateSyntax(output.value)) {
      issues.push({
        path: `outputs.${name}.value`,
        message:
          "unsupported '{{...}}' syntax; use a whole-value $steps.<earlier-id>.output reference",
      });
    }
    for (const ref of workflowReferencesIn(output.value)) {
      validateInputReference(ref, pkg.manifest.inputs, `outputs.${name}.value`, issues);
      if (ref.namespace === "steps") {
        const [id, marker] = ref.path;
        if (!id || marker !== "output" || !earlier.has(id)) {
          issues.push({
            path: `outputs.${name}.value`,
            message: `output references unavailable step '${id ?? ""}'`,
          });
        }
      }
    }
  }
}

export interface ValidateWorkflowResult {
  plan?: WorkflowExecutionPlan;
  issues: WorkflowValidationIssue[];
}

export function validateWorkflowPackage(
  pkg: WorkflowPackage,
  registry: WorkflowStepRegistry,
  schemas = new WorkflowSchemaService(),
): ValidateWorkflowResult {
  const issues: WorkflowValidationIssue[] = [];
  validateReferences(pkg, issues);
  let inputValidator: CompiledWorkflowSchema | undefined;
  try {
    inputValidator = schemas.compile(pkg.manifest.inputs, "inputs");
  } catch (error) {
    issues.push({ path: "inputs", message: (error as Error).message });
  }
  const permissions = normalizedPermissions(pkg);
  const plannedSteps: PlannedWorkflowStep[] = [];
  const outputSchemas = new Map<string, JsonSchema>();
  for (const [ordinal, step] of pkg.manifest.steps.entries()) {
    const type = registry.get(step.uses);
    if (!type) {
      issues.push({
        path: `steps.${ordinal}.uses`,
        message: `workflow step type '${step.uses}' is not available`,
      });
      continue;
    }
    validateKnownStepOutputReferences(step.with, `steps.${ordinal}.with`, outputSchemas, issues);
    validateDataSelectPointer(step, ordinal, outputSchemas, issues);
    outputSchemas.set(step.id, effectiveStepOutputSchema(step, type.outputSchema));
    let timeoutMs: number | undefined;
    let retry: WorkflowRetryPolicy | undefined;
    let inputSchema: CompiledWorkflowSchema | undefined;
    let outputSchema: CompiledWorkflowSchema | undefined;
    try {
      timeoutMs = step.timeout
        ? parseWorkflowDuration(step.timeout, `${step.id}.timeout`)
        : type.defaultTimeoutMs;
      if (!timeoutMs) throw new Error(`step '${step.id}' has no finite timeout`);
      retry = normalizeRetry(step);
      inputSchema = schemas.compile(type.inputSchema, `${step.uses} input schema`);
      outputSchema = schemas.compile(type.outputSchema, `${step.uses} output schema`);
      const stepInputIssues = hasReference(step.with)
        ? validateReferenceBearingInput(type.inputSchema, step.with, schemas)
        : inputSchema.validate(step.with);
      for (const issue of stepInputIssues) {
        issues.push({ ...issue, path: `steps.${ordinal}.with${issue.path}` });
      }
      const classification = type.classify(step.with);
      const disallowedRetry = retry.when.find(
        (errorClass) => !classification.retryable.includes(errorClass),
      );
      if (disallowedRetry) {
        issues.push({
          path: `steps.${ordinal}.retry.when`,
          message: `'${disallowedRetry}' is not retryable for ${step.uses}`,
        });
      }
      if (
        (step.uses === "llm.generate@1" || !hasReference(step.with)) &&
        !workflowPermissionsContain(permissions, classification.permissions)
      ) {
        issues.push({
          path: `steps.${ordinal}`,
          message: `declared permissions do not cover ${step.uses}`,
        });
      }
    } catch (error) {
      issues.push({ path: `steps.${ordinal}`, message: (error as Error).message });
    }
    if (timeoutMs && retry && inputSchema && outputSchema) {
      plannedSteps.push({
        id: step.id,
        uses: step.uses,
        ordinal,
        type,
        with: step.with,
        timeoutMs,
        retry,
        allowUntrustedInput: step.allow_untrusted_input ?? false,
        inputValidator: inputSchema,
        outputValidator: outputSchema,
      });
    }
  }
  for (const [name, output] of Object.entries(pkg.manifest.outputs)) {
    validateKnownStepOutputReferences(output.value, `outputs.${name}.value`, outputSchemas, issues);
  }
  const outputs = Object.entries(pkg.manifest.outputs).flatMap(([name, output]) => {
    try {
      return [
        {
          name,
          value: output.value,
          schema: output.schema,
          validator: schemas.compile(output.schema, `outputs.${name}.schema`),
        },
      ];
    } catch (error) {
      issues.push({ path: `outputs.${name}.schema`, message: (error as Error).message });
      return [];
    }
  });
  let workflowTimeoutMs: number | undefined;
  try {
    workflowTimeoutMs = parseWorkflowDuration(pkg.manifest.execution.timeout, "execution.timeout");
  } catch (error) {
    issues.push({ path: "execution.timeout", message: (error as Error).message });
  }
  if (
    issues.length > 0 ||
    !inputValidator ||
    !workflowTimeoutMs ||
    plannedSteps.length !== pkg.manifest.steps.length ||
    outputs.length !== Object.keys(pkg.manifest.outputs).length
  ) {
    return { issues };
  }
  const maximumAttempts = plannedSteps.reduce((sum, step) => sum + 1 + step.retry.attempts, 0);
  const maximumModelCalls = plannedSteps
    .filter((step) => step.uses === "llm.generate@1")
    .reduce((sum, step) => {
      const value = step.with as { repair_attempts?: unknown };
      const repairs =
        typeof value.repair_attempts === "number" && Number.isInteger(value.repair_attempts)
          ? value.repair_attempts
          : 1;
      return sum + (1 + step.retry.attempts) * (1 + repairs);
    }, 0);
  return {
    issues: [],
    plan: {
      package: pkg,
      manifest: pkg.manifest,
      workflowTimeoutMs,
      inputValidator,
      steps: plannedSteps,
      outputs,
      permissions,
      maximumAttempts,
      maximumModelCalls,
    },
  };
}

export function emptyWorkflowPermissions(): WorkflowPermissions {
  return emptyPermissions();
}
