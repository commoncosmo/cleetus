import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { JsonSchema, WorkflowValidationIssue } from "./types";

function remoteRefIn(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = remoteRefIn(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof child === "string" && !child.startsWith("#")) return child;
    const found = remoteRefIn(child);
    if (found) return found;
  }
  return null;
}

function issueFrom(error: ErrorObject): WorkflowValidationIssue {
  return {
    path: error.instancePath || "/",
    message: error.message ?? "schema validation failed",
    keyword: error.keyword,
  };
}

export interface CompiledWorkflowSchema {
  validate(value: unknown): WorkflowValidationIssue[];
}

/** Strict, non-coercing JSON Schema service for workflow inputs, step outputs, and final outputs. */
export class WorkflowSchemaService {
  private readonly ajv = new Ajv({
    allErrors: true,
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateFormats: false,
  });

  compile(schema: JsonSchema, path = "schema"): CompiledWorkflowSchema {
    const remoteRef = remoteRefIn(schema);
    if (remoteRef) throw new Error(`${path} contains unsupported remote $ref '${remoteRef}'`);
    let fn: ValidateFunction;
    try {
      fn = this.ajv.compile(schema);
    } catch (error) {
      throw new Error(`${path} is invalid: ${(error as Error).message}`);
    }
    return {
      validate(value) {
        const ok = fn(value);
        if (ok) return [];
        return (fn.errors ?? []).map(issueFrom);
      },
    };
  }
}
