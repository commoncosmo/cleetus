import type { ProviderRegistry } from "./registry";

export interface ProviderCatalog {
  provider: string;
  models: string[];
  /** Set when this provider couldn't be reached; other providers still listed. */
  error?: string;
}

/** Models grouped by provider, in provider declaration order. */
export type Catalog = ProviderCatalog[];

/**
 * Fetch model lists from every configured provider in parallel. A provider that
 * can't be reached is recorded with an `error` rather than failing the whole
 * catalog, so one dead server never hides the others.
 */
export async function fetchCatalog(registry: ProviderRegistry): Promise<Catalog> {
  return Promise.all(
    registry.names().map(async (provider): Promise<ProviderCatalog> => {
      try {
        const models = (await registry.get(provider).listModels()).map((m) => m.id);
        return { provider, models };
      } catch (e) {
        return { provider, models: [], error: (e as Error).message };
      }
    }),
  );
}

/**
 * Human-readable listing. Provider labels are shown only when more than one
 * provider is configured (a single-provider setup needs no disambiguation).
 */
export function formatCatalog(catalog: Catalog): string {
  if (catalog.length === 0) return "(no providers configured)";
  const multi = catalog.length > 1;
  const indent = multi ? "  " : "";
  const lines: string[] = [];
  for (const pc of catalog) {
    if (multi) lines.push(`${pc.provider}:`);
    if (pc.error) lines.push(`${indent}(unreachable: ${pc.error})`);
    else if (pc.models.length === 0) lines.push(`${indent}(no models)`);
    else for (const m of pc.models) lines.push(`${indent}${m}`);
  }
  return lines.join("\n");
}

/** Render the catalog for `--list-models`: JSON when `json` is set (for the desktop app's model
 *  discovery), else the human-readable text. */
export function renderCatalog(catalog: Catalog, opts: { json: boolean }): string {
  return opts.json ? JSON.stringify(catalog) : formatCatalog(catalog);
}

/** Compact display of the active (provider, model). Provider is shown only when more than one is configured. */
export function formatActiveModel(
  active: { provider: string; model: string },
  providerCount: number,
): string {
  return providerCount > 1 ? `${active.model} (${active.provider})` : active.model;
}

export interface CatalogEntry {
  provider: string;
  model: string;
}

/** Flatten a catalog into selectable (provider, model) rows, in provider order. */
export function catalogEntries(catalog: Catalog): CatalogEntry[] {
  return catalog.flatMap((c) => c.models.map((model) => ({ provider: c.provider, model })));
}

export type ModelResolution =
  | { kind: "ok"; provider: string; model: string }
  | { kind: "not-found"; query: string }
  | { kind: "ambiguous"; model: string; providers: string[] };

/**
 * Resolve a `/model` argument against the catalog. Accepts `<model>` when the
 * name is unique across providers, or `<provider> <model>` to disambiguate when
 * the same model id exists on more than one provider. Model ids contain both `/`
 * and `:`, so a space-separated provider prefix is the only safe qualifier.
 */
export function resolveModelChoice(catalog: Catalog, arg: string): ModelResolution {
  const trimmed = arg.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const providerNames = new Set(catalog.map((c) => c.provider));

  if (tokens.length === 2 && providerNames.has(tokens[0]!)) {
    const provider = tokens[0]!;
    const model = tokens[1]!;
    const pc = catalog.find((c) => c.provider === provider);
    if (pc?.models.includes(model)) return { kind: "ok", provider, model };
    return { kind: "not-found", query: trimmed };
  }

  const matches = catalog.flatMap((c) =>
    c.models.includes(trimmed) ? [{ provider: c.provider }] : [],
  );
  if (matches.length === 1) return { kind: "ok", provider: matches[0]!.provider, model: trimmed };
  if (matches.length === 0) return { kind: "not-found", query: trimmed };
  return { kind: "ambiguous", model: trimmed, providers: matches.map((m) => m.provider) };
}

export interface ModelCompletion {
  /** Shown in the suggestion list. */
  display: string;
  /** The full input line to substitute when accepted (always resolvable). */
  value: string;
}

/**
 * Autocomplete candidates for a `/model <partial>` input line, matched against
 * model ids across all providers. A model that exists on multiple providers is
 * completed to the disambiguated `<provider> <model>` form so the result always
 * resolves. Returns [] for any line that isn't a `/model ` prompt.
 */
export function completeModelLine(catalog: Catalog, line: string): ModelCompletion[] {
  const m = /^\/model\s+(.*)$/.exec(line);
  if (!m) return [];
  const partial = m[1]!.toLowerCase();
  const multi = catalog.length > 1;
  const entries = catalogEntries(catalog);

  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.model, (counts.get(e.model) ?? 0) + 1);

  return entries
    .filter((e) => e.model.toLowerCase().includes(partial))
    .map((e) => ({
      display: multi ? `${e.model} (${e.provider})` : e.model,
      value:
        (counts.get(e.model) ?? 0) > 1 ? `/model ${e.provider} ${e.model}` : `/model ${e.model}`,
    }));
}
