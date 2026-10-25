import type { ProviderConfig } from "../config/types";
import { buildProvider } from "../providers/factory";
import type { EnvironmentCheck } from "./windows-environment";

/** Probe only model listings. Never echo raw transport errors, URLs, or credentials. */
export function providerEnvironmentChecks(
  providers: [string, ProviderConfig][],
  listCount: (provider: ProviderConfig) => Promise<number> = async (p) =>
    (await buildProvider(p.type, p.baseUrl, p.apiKey).listModels()).length,
  timeoutMs = 4000,
): Promise<EnvironmentCheck[]> {
  return Promise.all(
    providers.map(async ([name, p]): Promise<EnvironmentCheck> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const count = await Promise.race([
          listCount(p),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
          }),
        ]);
        return {
          id: `provider-${name}`,
          label: `Provider ${name}`,
          requirement: "recommended",
          status: count ? "pass" : "warn",
          detail: count
            ? `Endpoint responds with ${count} model(s).`
            : "Endpoint responds but lists no models.",
        };
      } catch {
        return {
          id: `provider-${name}`,
          label: `Provider ${name}`,
          requirement: "recommended",
          status: "warn",
          detail:
            "Model listing failed or timed out; check the server and configuration. Credentials and endpoint URLs are omitted.",
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
}
