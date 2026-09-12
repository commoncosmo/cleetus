import {
  type ResolvedValue,
  type ValueProvenance,
  mergeProvenance,
  provenance,
  resolved,
} from "./provenance";
import type { JsonValue } from "./types";

const WHOLE_REFERENCE =
  /^\$(inputs|steps|run|secrets)(?:\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))?$/;
const INTERPOLATION =
  /\$\{(inputs|steps|run|secrets)(?:\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))?\}/g;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface WorkflowReference {
  namespace: "inputs" | "steps" | "run" | "secrets";
  path: string[];
}

export interface WorkflowReferenceContext {
  inputs: ResolvedValue;
  steps: Record<string, { output: ResolvedValue }>;
  run: {
    id: string;
    started_at: string;
    workspace: string;
  };
  secrets: Record<string, ResolvedValue>;
  /** Step ids available at this point. Excludes the current and all later steps. */
  availableSteps: ReadonlySet<string>;
}

type Reference = WorkflowReference;

/**
 * Find references using the same syntax accepted by the runtime resolver.
 *
 * Plain references must occupy the entire string, while ${...} references may
 * be interpolated into a larger string.
 */
export function workflowReferencesIn(value: JsonValue): WorkflowReference[] {
  const references: WorkflowReference[] = [];
  const visit = (current: JsonValue): void => {
    if (typeof current === "string") {
      const whole = WHOLE_REFERENCE.exec(current);
      if (whole) {
        references.push(parseReference(whole[1] as WorkflowReference["namespace"], whole[2]));
        return;
      }
      for (const match of current.matchAll(INTERPOLATION)) {
        references.push(parseReference(match[1] as WorkflowReference["namespace"], match[2]));
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (current && typeof current === "object") {
      for (const child of Object.values(current)) visit(child);
    }
  };
  visit(value);
  return references;
}

function assertSafePath(path: string[]): void {
  const unsafe = path.find((part) => UNSAFE_KEYS.has(part));
  if (unsafe) throw new Error(`workflow reference contains unsafe path segment '${unsafe}'`);
}

function parseReference(namespace: Reference["namespace"], rawPath: string | undefined): Reference {
  const path = rawPath ? rawPath.split(".") : [];
  assertSafePath(path);
  return { namespace, path };
}

function childAt(value: unknown, path: string[], label: string): JsonValue {
  let current = value;
  for (const part of path) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(part))
        throw new Error(`${label} has invalid array index '${part}'`);
      current = current[Number(part)];
    } else if (current && typeof current === "object") {
      if (!Object.hasOwn(current, part)) throw new Error(`${label} does not contain '${part}'`);
      current = (current as Record<string, unknown>)[part];
    } else {
      throw new Error(`${label} cannot select '${part}'`);
    }
  }
  if (!isJsonValue(current)) throw new Error(`${label} did not resolve to a JSON-compatible value`);
  return current;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, child]) => !UNSAFE_KEYS.has(key) && isJsonValue(child),
  );
}

function resolveReference(ref: Reference, ctx: WorkflowReferenceContext): ResolvedValue {
  if (ref.namespace === "inputs") {
    return resolved(childAt(ctx.inputs.value, ref.path, "$inputs"), ctx.inputs.provenance);
  }
  if (ref.namespace === "secrets") {
    const [name, ...rest] = ref.path;
    if (!name) throw new Error("$secrets requires a declared secret name");
    const secret = ctx.secrets[name];
    if (!secret) throw new Error(`$secrets does not contain '${name}'`);
    return resolved(childAt(secret.value, rest, `$secrets.${name}`), {
      ...secret.provenance,
      sensitive: true,
    });
  }
  if (ref.namespace === "run") {
    const [name, ...rest] = ref.path;
    if (!name || rest.length > 0 || !Object.hasOwn(ctx.run, name)) {
      throw new Error(`unsupported $run reference '${ref.path.join(".")}'`);
    }
    return resolved(ctx.run[name as keyof WorkflowReferenceContext["run"]], {
      origins: [`run:${name}`],
    });
  }

  const [stepId, output, ...rest] = ref.path;
  if (!stepId || output !== "output") {
    throw new Error("$steps references must use $steps.<id>.output");
  }
  if (!ctx.availableSteps.has(stepId)) {
    throw new Error(`$steps.${stepId} is not an available earlier step`);
  }
  const step = ctx.steps[stepId];
  if (!step) throw new Error(`$steps.${stepId} has no successful output`);
  return resolved(
    childAt(step.output.value, rest, `$steps.${stepId}.output`),
    step.output.provenance,
  );
}

function interpolate(value: string, ctx: WorkflowReferenceContext): ResolvedValue<string> {
  const provenances: ValueProvenance[] = [];
  let matched = false;
  const text = value.replace(INTERPOLATION, (_whole, namespace: Reference["namespace"], path) => {
    matched = true;
    const selected = resolveReference(parseReference(namespace, path), ctx);
    if (
      selected.value !== null &&
      typeof selected.value !== "string" &&
      typeof selected.value !== "number" &&
      typeof selected.value !== "boolean"
    ) {
      throw new Error("workflow interpolation accepts scalar values only");
    }
    provenances.push(selected.provenance);
    return String(selected.value);
  });
  return resolved(
    text,
    matched ? mergeProvenance(provenances) : provenance({ origins: ["manifest:literal"] }),
  );
}

/** Resolve references recursively without evaluating code or mutating the input template. */
export function resolveWorkflowValue(
  template: JsonValue,
  ctx: WorkflowReferenceContext,
): ResolvedValue {
  if (typeof template === "string") {
    const whole = WHOLE_REFERENCE.exec(template);
    if (whole) {
      return resolveReference(parseReference(whole[1] as Reference["namespace"], whole[2]), ctx);
    }
    return interpolate(template, ctx);
  }
  if (Array.isArray(template)) {
    const children = template.map((child) => resolveWorkflowValue(child, ctx));
    return resolved(
      children.map((child) => child.value),
      mergeProvenance(children.map((child) => child.provenance)),
    );
  }
  if (template && typeof template === "object") {
    const output: Record<string, JsonValue> = {};
    const childProvenance: ValueProvenance[] = [];
    for (const [key, child] of Object.entries(template)) {
      assertSafePath([key]);
      const selected = resolveWorkflowValue(child, ctx);
      output[key] = selected.value;
      childProvenance.push(selected.provenance);
    }
    return resolved(output, mergeProvenance(childProvenance));
  }
  return resolved(template, { origins: ["manifest:literal"] });
}
