import { describe, expect, it } from "bun:test";
import {
  type Catalog,
  catalogEntries,
  completeModelLine,
  fetchCatalog,
  formatActiveModel,
  formatCatalog,
  resolveModelChoice,
} from "../../src/providers/catalog";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, StreamEvent } from "../../src/providers/types";

class Fake implements Provider {
  constructor(
    private readonly models: string[],
    private readonly fail = false,
  ) {}
  async listModels() {
    if (this.fail) throw new Error("boom");
    return this.models.map((id) => ({ id }));
  }
  async *chat(): AsyncIterable<StreamEvent> {
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

describe("fetchCatalog", () => {
  it("aggregates models per provider in declaration order", async () => {
    const reg = new ProviderRegistry();
    reg.register("lm", new Fake(["a", "b"]));
    reg.register("ol", new Fake(["c"]));
    expect(await fetchCatalog(reg)).toEqual([
      { provider: "lm", models: ["a", "b"] },
      { provider: "ol", models: ["c"] },
    ]);
  });

  it("captures a provider error without failing the others", async () => {
    const reg = new ProviderRegistry();
    reg.register("lm", new Fake(["a"]));
    reg.register("down", new Fake([], true));
    const cat = await fetchCatalog(reg);
    expect(cat[0]).toEqual({ provider: "lm", models: ["a"] });
    expect(cat[1]!.provider).toBe("down");
    expect(cat[1]!.models).toEqual([]);
    expect(cat[1]!.error).toContain("boom");
  });
});

describe("formatCatalog", () => {
  it("labels by provider when multiple are configured", () => {
    const out = formatCatalog([
      { provider: "lm", models: ["a", "b"] },
      { provider: "ol", models: ["c"] },
    ]);
    expect(out).toContain("lm:");
    expect(out).toContain("ol:");
    expect(out).toContain("  a");
  });

  it("omits labels for a single provider", () => {
    expect(formatCatalog([{ provider: "lm", models: ["a", "b"] }])).toBe("a\nb");
  });

  it("notes unreachable providers and empty results", () => {
    const out = formatCatalog([
      { provider: "lm", models: [], error: "boom" },
      { provider: "ol", models: [] },
    ]);
    expect(out).toContain("(unreachable: boom)");
    expect(out).toContain("(no models)");
  });

  it("handles no providers", () => {
    expect(formatCatalog([])).toBe("(no providers configured)");
  });
});

describe("formatActiveModel", () => {
  it("shows just the model when a single provider is configured", () => {
    expect(formatActiveModel({ provider: "lmstudio", model: "qwen-coder" }, 1)).toBe("qwen-coder");
  });

  it("shows model and provider when more than one provider is configured", () => {
    expect(formatActiveModel({ provider: "lmstudio", model: "qwen-coder" }, 2)).toBe(
      "qwen-coder (lmstudio)",
    );
  });
});

describe("catalogEntries", () => {
  it("flattens to provider/model rows in order, skipping unreachable providers", () => {
    expect(
      catalogEntries([
        { provider: "lm", models: ["a", "b"] },
        { provider: "down", models: [], error: "boom" },
        { provider: "ol", models: ["c"] },
      ]),
    ).toEqual([
      { provider: "lm", model: "a" },
      { provider: "lm", model: "b" },
      { provider: "ol", model: "c" },
    ]);
  });
});

describe("completeModelLine", () => {
  const cat: Catalog = [
    { provider: "lm", models: ["alpha", "beta"] },
    { provider: "ol", models: ["beta", "gamma"] },
  ];

  it("returns nothing for lines that aren't a /model prompt", () => {
    expect(completeModelLine(cat, "hello")).toEqual([]);
    expect(completeModelLine(cat, "/models ls")).toEqual([]);
    expect(completeModelLine(cat, "/model")).toEqual([]);
  });

  it("suggests all models on an empty partial, labeled by provider", () => {
    const out = completeModelLine(cat, "/model ");
    expect(out.map((s) => s.display)).toEqual([
      "alpha (lm)",
      "beta (lm)",
      "beta (ol)",
      "gamma (ol)",
    ]);
  });

  it("filters by the partial (case-insensitive)", () => {
    expect(completeModelLine(cat, "/model GAM").map((s) => s.value)).toEqual(["/model gamma"]);
  });

  it("completes unique models to `/model <name>` and ambiguous to `/model <provider> <name>`", () => {
    expect(completeModelLine(cat, "/model alpha")[0]!.value).toBe("/model alpha");
    const beta = completeModelLine(cat, "/model beta");
    expect(beta.map((s) => s.value)).toEqual(["/model lm beta", "/model ol beta"]);
  });

  it("omits provider labels when only one provider is configured", () => {
    const out = completeModelLine([{ provider: "lm", models: ["alpha"] }], "/model ");
    expect(out).toEqual([{ display: "alpha", value: "/model alpha" }]);
  });
});

describe("resolveModelChoice", () => {
  const cat: Catalog = [
    { provider: "lm", models: ["alpha", "beta"] },
    { provider: "ol", models: ["beta", "gamma"] },
  ];

  it("resolves a model unique across providers", () => {
    expect(resolveModelChoice(cat, "gamma")).toEqual({
      kind: "ok",
      provider: "ol",
      model: "gamma",
    });
  });

  it("flags ambiguity for a shared model name", () => {
    const r = resolveModelChoice(cat, "beta");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.providers).toEqual(["lm", "ol"]);
  });

  it("disambiguates with <provider> <model>", () => {
    expect(resolveModelChoice(cat, "ol beta")).toEqual({
      kind: "ok",
      provider: "ol",
      model: "beta",
    });
  });

  it("returns not-found for an unknown model", () => {
    expect(resolveModelChoice(cat, "nope").kind).toBe("not-found");
  });

  it("returns not-found when a qualified model isn't on that provider", () => {
    expect(resolveModelChoice(cat, "lm gamma").kind).toBe("not-found");
  });
});
