import type { ProviderConfig } from "../config/types";
import { buildProvider } from "../providers/factory";
import type { EnvironmentCheck } from "./windows-environment";

/** Probe model listings and Strata context readiness. Never echo raw transport errors or credentials. */
export function providerEnvironmentChecks(
  providers: [string, ProviderConfig][],
  listCount?: (provider: ProviderConfig) => Promise<number>,
  timeoutMs = 4000,
): Promise<EnvironmentCheck[]> {
  return Promise.all(
    providers.map(async ([name, p]): Promise<EnvironmentCheck> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const probe = async () => {
          if (listCount) return { count: await listCount(p), warnings: [] as string[] };
          const provider = buildProvider(p.type, p.baseUrl, p.apiKey, p);
          const models = await provider.listModels();
          const warnings =
            p.type === "strata" && models[0]
              ? ((await provider.readinessWarnings?.(models[0].id)) ?? [])
              : [];
          return { count: models.length, warnings };
        };
        const { count, warnings } = await Promise.race([
          probe(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
          }),
        ]);
        return {
          id: `provider-${name}`,
          label: `Provider ${name}`,
          requirement: "recommended",
          status: count && !warnings.length ? "pass" : "warn",
          detail: count
            ? `Endpoint responds with ${count} model(s). ${warnings.join(" ")}`.trim()
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
