import { FAMILIES } from "./registry";
import type { FamilyAdapter, ModelFamilyName } from "./types";

/** Resolve the family for a model id. `override` (from config) wins; else first substring match;
 *  else null (request-shaping becomes a pass-through, recovery sniffs all formats). Pure. */
export function detectFamily(modelId: string, override?: ModelFamilyName): FamilyAdapter | null {
  if (override) return FAMILIES.find((f) => f.name === override) ?? null;
  return FAMILIES.find((f) => f.matches(modelId)) ?? null;
}
