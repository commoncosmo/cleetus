import { usableContextLength } from "./types";

export interface StrataModelRow {
  id?: unknown;
  meta?: { label?: unknown; context?: unknown; instanceId?: unknown; aliases?: unknown };
}

/** Native desktop state must identify the exact ready instance, never the default model.
 * Engine max_context and configured context are both served limits; use the smaller when
 * both exist. Model architecture/catalog ceilings are deliberately not consumed. */
export function parseStrataNativeContext(
  model: string,
  row: StrataModelRow | undefined,
  payload: unknown,
): number | undefined {
  const instances = (payload as { instances?: unknown } | null)?.instances;
  if (!Array.isArray(instances)) return undefined;
  const candidates = instances.filter((instance) => {
    if (!instance || instance.status !== "ready") return false;
    if (typeof row?.meta?.instanceId === "string" && instance.id !== row.meta.instanceId)
      return false;
    return true;
  });
  // Strata resolves an exact served ID ahead of another instance's colliding alias.
  const exact = candidates.filter((instance) => instance.apiModelId === model);
  const matches = exact.length
    ? exact
    : candidates.filter(
        (instance) => Array.isArray(instance.aliases) && instance.aliases.includes(model),
      );
  if (matches.length !== 1) return undefined;
  const instance = matches[0];
  const limits = [
    usableContextLength(instance.metrics?.engine?.max_context),
    usableContextLength(instance.context),
  ].filter((value): value is number => value !== undefined);
  return limits.length ? Math.min(...limits) : undefined;
}
