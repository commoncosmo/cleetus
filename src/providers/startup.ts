import { type Catalog, catalogEntries } from "./catalog";

export interface StartupInput {
  /** --provider flag. */
  requestedProvider?: string;
  /** --model flag. */
  requestedModel?: string;
  /** config.default_provider. */
  defaultProvider?: string;
  /** config.default_model. */
  defaultModel?: string;
}

export type StartupResolution =
  | { kind: "ready"; provider: string; model: string }
  /** No usable (provider, model) determined — the UI should let the user choose. */
  | { kind: "pick"; note?: string }
  | { kind: "error"; message: string };

/**
 * Decide the startup (provider, model) from flags, config defaults, and the
 * cross-provider catalog — without showing a picker when the answer is already
 * known. Model names are matched across all providers: an explicit --provider
 * pins the search; otherwise a configured default_provider is preferred, then a
 * model that's unique across providers wins. Anything unresolved becomes "pick".
 */
export function resolveStartupChoice(catalog: Catalog, input: StartupInput): StartupResolution {
  const { requestedProvider, requestedModel, defaultProvider, defaultModel } = input;
  const providerNames = catalog.map((c) => c.provider);
  const has = (p: string, m: string) =>
    catalog.find((c) => c.provider === p)?.models.includes(m) ?? false;

  if (providerNames.length === 0) {
    return {
      kind: "error",
      message:
        "no providers configured. add an lmstudio, ollama, or llama.cpp provider to ~/.config/cleetus/config.yaml",
    };
  }
  if (requestedProvider && !providerNames.includes(requestedProvider)) {
    return {
      kind: "error",
      message: `provider '${requestedProvider}' not found. configured: ${providerNames.join(", ")}`,
    };
  }
  if (catalogEntries(catalog).length === 0) {
    return { kind: "error", message: "no models available from any provider" };
  }

  const model = requestedModel ?? defaultModel;
  if (!model) return { kind: "pick" };

  if (requestedProvider) {
    if (has(requestedProvider, model)) return { kind: "ready", provider: requestedProvider, model };
    return { kind: "error", message: `model '${model}' not found on '${requestedProvider}'` };
  }

  if (defaultProvider && has(defaultProvider, model)) {
    return { kind: "ready", provider: defaultProvider, model };
  }

  const owners = catalog.filter((c) => c.models.includes(model)).map((c) => c.provider);
  if (owners.length === 1) return { kind: "ready", provider: owners[0]!, model };
  if (owners.length === 0)
    return { kind: "pick", note: `model '${model}' not found on any provider` };
  return {
    kind: "pick",
    note: `model '${model}' exists on multiple providers (${owners.join(", ")})`,
  };
}
