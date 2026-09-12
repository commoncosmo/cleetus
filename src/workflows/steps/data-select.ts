import type { ResolvedValue } from "../provenance";
import { resolved } from "../provenance";
import type { WorkflowStepType } from "../step-registry";
import type { JsonValue } from "../types";

interface DataSelectInput {
  value: JsonValue;
  pointer: string;
  default?: JsonValue;
}

function decodeSegment(value: string): string {
  if (/~(?![01])/u.test(value)) throw new Error(`invalid JSON Pointer escape in '${value}'`);
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function selectJsonPointer(
  input: JsonValue,
  pointer: string,
): {
  found: boolean;
  value?: JsonValue;
} {
  if (pointer === "") return { found: true, value: input };
  if (!pointer.startsWith("/")) throw new Error("JSON Pointer must be empty or begin with '/'");
  let current: JsonValue = input;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = decodeSegment(encoded);
    if (["__proto__", "prototype", "constructor"].includes(segment)) {
      throw new Error(`unsafe JSON Pointer segment '${segment}'`);
    }
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index]!;
    } else if (current && typeof current === "object") {
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = current[segment]!;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

export const dataSelectStep: WorkflowStepType = {
  name: "data.select",
  version: 1,
  defaultTimeoutMs: 1_000,
  inputSchema: {
    type: "object",
    required: ["value", "pointer"],
    properties: {
      value: {},
      pointer: { type: "string" },
      default: {},
    },
    additionalProperties: false,
  },
  outputSchema: {},
  classify: () => ({ effect: "read-only", permissions: {}, retryable: [] }),
  preview(input) {
    return `Select JSON Pointer ${(input as unknown as DataSelectInput).pointer}`;
  },
  async execute(input: ResolvedValue) {
    const selectedInput = input.value as unknown as DataSelectInput;
    const selected = selectJsonPointer(selectedInput.value, selectedInput.pointer);
    if (selected.found) return resolved(selected.value!, input.provenance);
    if (Object.hasOwn(selectedInput, "default")) {
      return resolved(selectedInput.default!, input.provenance);
    }
    throw new Error(`JSON Pointer '${selectedInput.pointer}' did not match a value`);
  },
};
