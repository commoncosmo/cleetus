import { describe, expect, it } from "bun:test";
import { ModelContextCache } from "../../src/providers/model-context-cache";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ModelInfo, Provider, StreamEvent } from "../../src/providers/types";

class Fake implements Provider {
  calls = 0;
  constructor(
    private readonly models: ModelInfo[],
    private readonly fail = false,
  ) {}
  async listModels(): Promise<ModelInfo[]> {
    this.calls++;
    if (this.fail) throw new Error("boom");
    return this.models;
  }
  async *chat(): AsyncIterable<StreamEvent> {
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

// A provider whose listModels reports no context until `loaded` flips true (model load).
class Loading implements Provider {
  loaded = false;
  calls = 0;
  async listModels(): Promise<ModelInfo[]> {
    this.calls++;
    return [this.loaded ? { id: "m", contextLength: 8000 } : { id: "m" }];
  }
  async *chat(): AsyncIterable<StreamEvent> {
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

// A provider whose listModels blocks on a gate, to hold one refresh in flight.
class Gated implements Provider {
  calls = 0;
  constructor(private readonly gate: Promise<void>) {}
  async listModels(): Promise<ModelInfo[]> {
    this.calls++;
    await this.gate;
    return [{ id: "m", contextLength: 8000 }];
  }
  async *chat(): AsyncIterable<StreamEvent> {
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

// A provider whose listModels reports no window (empty /api/ps) but whose /api/show probe
// returns a fixed architectural window. Models an Ollama CLOUD model.
class CloudLike implements Provider {
  listCalls = 0;
  probeCalls = 0;
  constructor(private readonly probeWindow: number | undefined) {}
  async listModels(): Promise<ModelInfo[]> {
    this.listCalls++;
    return [{ id: "m" }]; // present, but no contextLength (never in /api/ps)
  }
  async probeModelContext(_model: string): Promise<number | undefined> {
    this.probeCalls++;
    return this.probeWindow;
  }
  async *chat(): AsyncIterable<StreamEvent> {
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

class NativeLoadedProbe implements Provider {
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async probeModelContextInfo() {
    return { window: 32768, source: "loaded" as const };
  }
  async *chat(): AsyncIterable<StreamEvent> {
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

function reg(provider: string, p: Provider): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(provider, p);
  return r;
}

describe("ModelContextCache", () => {
  it("preserves provider-native loaded probe evidence", async () => {
    const cache = new ModelContextCache(reg("llama", new NativeLoadedProbe()));
    await cache.prime([{ provider: "llama", model: "m" }]);
    expect(cache.getInfo("llama", "m")).toEqual({ window: 32768, source: "loaded" });
  });

  it("prime awaits architectural context for cold routed models", async () => {
    const providers = new ProviderRegistry();
    const small = new CloudLike(131072);
    const large = new CloudLike(262144);
    providers.register("small-provider", small);
    providers.register("large-provider", large);
    const cache = new ModelContextCache(providers);

    await cache.prime([
      { provider: "small-provider", model: "m" },
      { provider: "large-provider", model: "m" },
      { provider: "small-provider", model: "m" },
    ]);

    expect(cache.getInfo("small-provider", "m")).toEqual({
      window: 131072,
      source: "architectural",
    });
    expect(cache.getInfo("large-provider", "m")).toEqual({
      window: 262144,
      source: "architectural",
    });
    expect(small.probeCalls).toBe(1);
    expect(large.probeCalls).toBe(1);
  });

  it("returns undefined before warming", () => {
    const cache = new ModelContextCache(reg("lm", new Fake([{ id: "m", contextLength: 8000 }])));
    expect(cache.get("lm", "m")).toBeUndefined();
  });

  it("after warm, get returns the model's contextLength", async () => {
    const cache = new ModelContextCache(reg("lm", new Fake([{ id: "m", contextLength: 8000 }])));
    await cache.warm("lm");
    expect(cache.get("lm", "m")).toBe(8000);
  });

  it("returns undefined for a model with no contextLength", async () => {
    const cache = new ModelContextCache(reg("lm", new Fake([{ id: "m" }])));
    await cache.warm("lm");
    expect(cache.get("lm", "m")).toBeUndefined();
  });

  it("does not cache a zero context sentinel as an authoritative loaded window", async () => {
    const cache = new ModelContextCache(reg("lm", new Fake([{ id: "m", contextLength: 0 }])));
    await cache.warm("lm");
    expect(cache.getInfo("lm", "m")).toBeUndefined();
  });

  it("returns undefined for an unknown model", async () => {
    const cache = new ModelContextCache(reg("lm", new Fake([{ id: "m", contextLength: 8000 }])));
    await cache.warm("lm");
    expect(cache.get("lm", "other")).toBeUndefined();
  });

  it("a throwing listModels leaves the cache empty and does not reject", async () => {
    const cache = new ModelContextCache(reg("lm", new Fake([], true)));
    await cache.warm("lm"); // must not throw
    expect(cache.get("lm", "m")).toBeUndefined();
  });

  it("memoizes: warm called twice fetches listModels at most once", async () => {
    const fake = new Fake([{ id: "m", contextLength: 8000 }]);
    const cache = new ModelContextCache(reg("lm", fake));
    await cache.warm("lm");
    await cache.warm("lm");
    expect(fake.calls).toBe(1);
  });

  it("warm on an unregistered provider does not throw", async () => {
    const cache = new ModelContextCache(new ProviderRegistry());
    await cache.warm("nope");
    expect(cache.get("nope", "m")).toBeUndefined();
  });

  it("re-fetches and picks up a window that becomes known after the model loads", async () => {
    const stub = new Loading();
    let t = 1000;
    const cache = new ModelContextCache(reg("lm", stub), { now: () => t, refreshIntervalMs: 5000 });
    await cache.warm("lm");
    expect(cache.get("lm", "m")).toBeUndefined(); // cold: no contextLength — fires a background refresh
    await new Promise((r) => setTimeout(r, 0)); // let the background refresh settle so inFlight clears
    stub.loaded = true; // model now loaded → /api/ps reports the window
    t += 6000; // advance past the throttle
    await cache.refresh("lm");
    expect(cache.get("lm", "m")).toBe(8000);
  });

  it("get() on a miss schedules a background refresh that populates the value", async () => {
    const stub = new Loading();
    let t = 1000;
    const cache = new ModelContextCache(reg("lm", stub), { now: () => t, refreshIntervalMs: 5000 });
    await cache.warm("lm"); // cold
    stub.loaded = true;
    t += 6000;
    expect(cache.get("lm", "m")).toBeUndefined(); // miss → fire-and-forget refresh
    await new Promise((r) => setTimeout(r, 0)); // let the background refresh settle
    expect(cache.get("lm", "m")).toBe(8000);
  });

  it("throttles background refresh to once per interval per provider", async () => {
    const stub = new Loading();
    let t = 1000;
    const cache = new ModelContextCache(reg("lm", stub), { now: () => t, refreshIntervalMs: 5000 });
    await cache.warm("lm"); // calls=1
    await cache.refresh("lm"); // calls=2 (first refresh; lastRefresh was -inf)
    await cache.refresh("lm"); // throttled (same t) → no call
    expect(stub.calls).toBe(2);
    t += 6000; // past interval
    await cache.refresh("lm"); // calls=3
    expect(stub.calls).toBe(3);
  });

  it("does not start an overlapping refresh while one is in flight", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const stub = new Gated(gate);
    const t = 10_000; // clock fixed; this test exercises the in-flight guard, not the throttle
    const cache = new ModelContextCache(reg("lm", stub), { now: () => t, refreshIntervalMs: 5000 });
    const p1 = cache.refresh("lm"); // starts the fetch, in-flight
    const p2 = cache.refresh("lm"); // in-flight → no second fetch
    openGate();
    await Promise.all([p1, p2]);
    expect(stub.calls).toBe(1);
  });
});

describe("ModelContextCache source semantics", () => {
  it("falls back to an architectural probe when loaded metadata reports zero", async () => {
    class ZeroLoadedWithProbe extends CloudLike {
      override async listModels(): Promise<ModelInfo[]> {
        this.listCalls++;
        return [{ id: "m", contextLength: 0 }];
      }
    }
    const providers = new ProviderRegistry();
    const p = new ZeroLoadedWithProbe(131072);
    providers.register("ollama", p);
    const cache = new ModelContextCache(providers, { refreshIntervalMs: 0 });
    await cache.warm("ollama");
    expect(cache.getInfo("ollama", "m")).toBeUndefined();
    await cache.probe("ollama", "m");
    expect(cache.getInfo("ollama", "m")).toEqual({ window: 131072, source: "architectural" });
  });

  it("resolves an architectural window via probe when listModels reports none (cloud model)", async () => {
    const providers = new ProviderRegistry();
    const p = new CloudLike(1_000_000);
    providers.register("ollama", p);
    const cache = new ModelContextCache(providers);
    expect(cache.getInfo("ollama", "m")).toBeUndefined(); // miss: schedules probe + list
    await cache.probe("ollama", "m"); // await the targeted /api/show
    expect(cache.getInfo("ollama", "m")).toEqual({ window: 1_000_000, source: "architectural" });
    expect(cache.get("ollama", "m")).toBe(1_000_000);
  });

  it("loaded overwrites architectural; architectural never overwrites loaded", async () => {
    const providers = new ProviderRegistry();
    // Fake reports a loaded window of 8000 from listModels.
    providers.register("ollama", new Fake([{ id: "m", contextLength: 8000 }]));
    const cache = new ModelContextCache(providers);
    await cache.warm("ollama");
    expect(cache.getInfo("ollama", "m")).toEqual({ window: 8000, source: "loaded" });
    // A later probe must NOT clobber the loaded window.
    await cache.probe("ollama", "m"); // Fake has no probeModelContext → no-op
    expect(cache.getInfo("ollama", "m")).toEqual({ window: 8000, source: "loaded" });
  });

  it("a loaded window from a later refresh replaces a cached architectural window", async () => {
    const providers = new ProviderRegistry();
    // Provider that starts cloud-like, then begins reporting a loaded window once `flip`.
    class Flipping implements Provider {
      flip = false;
      async listModels(): Promise<ModelInfo[]> {
        return [this.flip ? { id: "m", contextLength: 4096 } : { id: "m" }];
      }
      async probeModelContext(): Promise<number | undefined> {
        return 131072;
      }
      async *chat(): AsyncIterable<StreamEvent> {
        yield { type: "finish", reason: "stop" };
      }
      async embed() {
        return [0];
      }
    }
    const fp = new Flipping();
    providers.register("ollama", fp);
    const cache = new ModelContextCache(providers, { refreshIntervalMs: 0 });
    await cache.probe("ollama", "m");
    expect(cache.getInfo("ollama", "m")).toEqual({ window: 131072, source: "architectural" });
    await new Promise((r) => setTimeout(r, 0)); // let the implicit list-refresh from the read above settle
    fp.flip = true;
    await cache.refresh("ollama"); // /api/ps now reports the loaded 4096
    expect(cache.getInfo("ollama", "m")).toEqual({ window: 4096, source: "loaded" });
  });

  it("does not re-probe once an architectural window is cached", async () => {
    const providers = new ProviderRegistry();
    const p = new CloudLike(1_000_000);
    providers.register("ollama", p);
    const cache = new ModelContextCache(providers, { refreshIntervalMs: 0 });
    await cache.probe("ollama", "m");
    expect(p.probeCalls).toBe(1);
    cache.getInfo("ollama", "m"); // architectural cached → list-refresh only, NO re-probe
    await cache.probe("ollama", "m"); // explicit probe is a no-op guard once cached
    expect(p.probeCalls).toBe(1);
  });
});
