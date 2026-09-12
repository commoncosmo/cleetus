import type { JsonValue } from "./types";

export interface ValueProvenance {
  untrusted: boolean;
  sensitive: boolean;
  origins: string[];
}

export interface ResolvedValue<T extends JsonValue = JsonValue> {
  value: T;
  provenance: ValueProvenance;
}

export const TRUSTED_PROVENANCE: ValueProvenance = {
  untrusted: false,
  sensitive: false,
  origins: [],
};

export function provenance(input: Partial<ValueProvenance> = {}): ValueProvenance {
  return {
    untrusted: input.untrusted ?? false,
    sensitive: input.sensitive ?? false,
    origins: [...new Set(input.origins ?? [])].sort(),
  };
}

export function mergeProvenance(values: ValueProvenance[]): ValueProvenance {
  return provenance({
    untrusted: values.some((value) => value.untrusted),
    sensitive: values.some((value) => value.sensitive),
    origins: values.flatMap((value) => value.origins),
  });
}

export function resolved<T extends JsonValue>(
  value: T,
  valueProvenance: Partial<ValueProvenance> = {},
): ResolvedValue<T> {
  return { value, provenance: provenance(valueProvenance) };
}

/** Conservative redaction: once a composite derives from a secret, redact the complete value. */
export function redactResolved(value: ResolvedValue): JsonValue {
  return value.provenance.sensitive ? "[REDACTED]" : value.value;
}
