import type { ProviderRegistry } from "./registry";
import { type WindowInfo, type WindowSource, usableContextLength } from "./types";

export interface ModelContextTarget {
  provider: string;
  model: string;
}

export interface ModelContextCacheOptions {
  now?: () => number;
  refreshIntervalMs?: number;
}

/**
 * Caches each provider's model context windows so the runtime can read the active model's real
 * window synchronously, tagged with its source: `loaded` (Ollama /api/ps — the currently-loaded
 * window, authoritative) or `architectural` (for example Ollama /api/show — the model's ceiling,
 * used when loaded metadata is unavailable). Provider-native probes such as llama.cpp /props can
 * also return authoritative `loaded` evidence. `loaded` always wins.
 *
 * `warm` fetches a provider's `listModels()` once (source `loaded`). A `get`/`getInfo` miss
 * schedules a targeted `/api/show` `probe` for that one model plus a `/api/ps` list-refresh; while
 * a window is only `architectural`, `get` keeps re-polling `/api/ps` so a later `loaded` window
 * replaces it. Callers do not await background work; the runtime reads every model call, so the
 * budget and capability self-correct once evidence arrives.
 */
export class ModelContextCache {
  private readonly byKey = new Map<string, WindowInfo>();
  private readonly warmed = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<string>();
  private readonly lastRefresh = new Map<string, number>();
  private readonly probeInFlight = new Set<string>();
  private readonly lastProbe = new Map<string, number>();
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;

  constructor(
    private readonly providers: ProviderRegistry,
    opts: ModelContextCacheOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 5000;
  }

  private static key(provider: string, model: string): string {
    return `${provider}:${model}`;
  }

  /** Record a window. `loaded` overwrites any prior entry; `architectural` writes only when no
   *  entry exists — it never clobbers a `loaded` window or an existing `architectural` one. */
  private setWindow(provider: string, model: string, window: number, source: WindowSource): void {
    const usable = usableContextLength(window);
    if (usable === undefined) return;
    const key = ModelContextCache.key(provider, model);
    if (source === "architectural" && this.byKey.has(key)) return;
    this.byKey.set(key, { window: usable, source });
  }

  /** Fetch a provider's loaded model windows (source `loaded`) and populate the cache. Never rejects. */
  private async fetchAndCache(provider: string): Promise<void> {
    try {
      const models = await this.providers.get(provider).listModels();
      for (const m of models) {
        const window = usableContextLength(m.contextLength);
        if (window !== undefined) this.setWindow(provider, m.id, window, "loaded");
      }
    } catch {
      // Advisory: an unreachable/erroring provider just leaves this provider uncached.
    }
  }

  /** Probe one model's best native context evidence. Never rejects. */
  private async probeAndCache(provider: string, model: string): Promise<void> {
    try {
      const p = this.providers.get(provider);
      let resolved: WindowInfo | undefined;
      if (typeof p.probeModelContextInfo === "function") {
        resolved = await p.probeModelContextInfo(model);
      } else if (typeof p.probeModelContext === "function") {
        const window = await p.probeModelContext(model);
        if (window !== undefined) resolved = { window, source: "architectural" };
      }
      const window = usableContextLength(resolved?.window);
      if (window !== undefined && resolved) {
        this.setWindow(provider, model, window, resolved.source);
      }
    } catch {
      // Advisory: an unregistered/erroring provider or a failed probe just leaves the model
      // unresolved (falls back to conservative small).
    }
  }

  /** Fetch and cache a provider's loaded windows (once per provider). Fire-and-forget at call
   *  sites; returns the promise so tests can await it. Never rejects. */
  warm(provider: string): Promise<void> {
    const existing = this.warmed.get(provider);
    if (existing) return existing;
    const p = this.fetchAndCache(provider);
    this.warmed.set(provider, p);
    return p;
  }

  /** Resolve the best context evidence available before an imminent first turn. Provider-level
   * loaded metadata is fetched once, then models still missing a window receive an awaited
   * architectural probe. This is intentionally stronger than getInfo's background scheduling:
   * routing tiers may differ from the configured active model, and the first user prompt must not
   * get a reduced capability surface merely because its routed model was cold at startup. */
  async prime(targets: readonly ModelContextTarget[]): Promise<void> {
    const unique = [
      ...new Map(
        targets
          .filter((target) => target.provider && target.model)
          .map((target) => [ModelContextCache.key(target.provider, target.model), target]),
      ).values(),
    ];
    await Promise.all(
      [...new Set(unique.map((target) => target.provider))].map((p) => this.warm(p)),
    );
    await Promise.all(
      unique.map((target) =>
        this.byKey.has(ModelContextCache.key(target.provider, target.model))
          ? Promise.resolve()
          : this.probe(target.provider, target.model),
      ),
    );
  }

  /** Throttled background /api/ps re-fetch, to pick up a window that becomes `loaded` after the
   *  model loads (or to replace an `architectural` window). `inFlight` bounds to one fetch per
   *  provider; `refreshIntervalMs` bounds the rate. Never rejects. */
  refresh(provider: string): Promise<void> {
    if (this.inFlight.has(provider)) return Promise.resolve();
    const last = this.lastRefresh.get(provider) ?? Number.NEGATIVE_INFINITY;
    if (this.now() - last < this.refreshIntervalMs) return Promise.resolve();
    this.lastRefresh.set(provider, this.now());
    this.inFlight.add(provider);
    return this.fetchAndCache(provider).finally(() => this.inFlight.delete(provider));
  }

  /** Throttled targeted /api/show probe for one model, used on a true miss to resolve a window
   *  that /api/ps will never report (cloud model). No-op once any window is cached for the model.
   *  `probeInFlight` bounds to one probe per model; `refreshIntervalMs` bounds the rate. */
  probe(provider: string, model: string): Promise<void> {
    const key = ModelContextCache.key(provider, model);
    if (this.byKey.has(key)) return Promise.resolve();
    if (this.probeInFlight.has(key)) return Promise.resolve();
    const last = this.lastProbe.get(key) ?? Number.NEGATIVE_INFINITY;
    if (this.now() - last < this.refreshIntervalMs) return Promise.resolve();
    this.lastProbe.set(key, this.now());
    this.probeInFlight.add(key);
    return this.probeAndCache(provider, model).finally(() => this.probeInFlight.delete(key));
  }

  /** The active model's window + source, or undefined when unknown. Schedules background work
   *  (fire-and-forget) unless the window is already authoritative (`loaded`):
   *   - missing → targeted /api/show probe + /api/ps list-refresh
   *   - architectural → /api/ps list-refresh only (seek the authoritative loaded window)
   *   - loaded → nothing. */
  getInfo(provider: string, model: string): WindowInfo | undefined {
    const v = this.byKey.get(ModelContextCache.key(provider, model));
    if (v?.source === "loaded") return v;
    void this.refresh(provider);
    if (v === undefined) void this.probe(provider, model);
    return v;
  }

  /** The active model's window (best-known, any source), or undefined. Budget path. */
  get(provider: string, model: string): number | undefined {
    return this.getInfo(provider, model)?.window;
  }
}
