import type { ProviderRegistry } from "./registry";

/** Run optional provider-native readiness checks without making advisory metadata a startup
 * dependency. Providers that do not expose checks, or whose check endpoint fails, are silent. */
export async function providerReadinessWarnings(
  providers: ProviderRegistry,
  provider: string,
  model: string,
): Promise<string[]> {
  try {
    const implementation = providers.get(provider);
    return typeof implementation.readinessWarnings === "function"
      ? await implementation.readinessWarnings(model)
      : [];
  } catch {
    return [];
  }
}
