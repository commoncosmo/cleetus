import { describe, expect, it } from "bun:test";
import type { Catalog } from "../../src/providers/catalog";
import { resolveStartupChoice } from "../../src/providers/startup";

const cat: Catalog = [
  { provider: "lm", models: ["alpha", "beta"] },
  { provider: "ol", models: ["beta", "gamma"] },
];

describe("resolveStartupChoice", () => {
  it("errors when no providers are configured", () => {
    const r = resolveStartupChoice([], {});
    expect(r.kind).toBe("error");
  });

  it("errors when an explicit --provider does not exist", () => {
    const r = resolveStartupChoice(cat, { requestedProvider: "nope" });
    expect(r.kind).toBe("error");
  });

  it("errors when providers exist but expose no models", () => {
    const r = resolveStartupChoice([{ provider: "lm", models: [], error: "down" }], {
      defaultModel: "x",
    });
    expect(r.kind).toBe("error");
  });

  it("asks the user to pick when no model is specified", () => {
    expect(resolveStartupChoice(cat, {})).toEqual({ kind: "pick" });
  });

  it("is ready when --provider and --model both resolve", () => {
    expect(resolveStartupChoice(cat, { requestedProvider: "ol", requestedModel: "gamma" })).toEqual(
      {
        kind: "ready",
        provider: "ol",
        model: "gamma",
      },
    );
  });

  it("errors when --model is not on the explicit --provider", () => {
    expect(
      resolveStartupChoice(cat, { requestedProvider: "lm", requestedModel: "gamma" }).kind,
    ).toBe("error");
  });

  it("is ready from default_provider + default_model", () => {
    expect(resolveStartupChoice(cat, { defaultProvider: "ol", defaultModel: "beta" })).toEqual({
      kind: "ready",
      provider: "ol",
      model: "beta",
    });
  });

  it("resolves a default_model to its provider even without default_provider", () => {
    expect(resolveStartupChoice(cat, { defaultModel: "gamma" })).toEqual({
      kind: "ready",
      provider: "ol",
      model: "gamma",
    });
  });

  it("resolves a default_model to a non-default provider when the default lacks it", () => {
    // default_provider lm doesn't have gamma; it's unique to ol
    expect(resolveStartupChoice(cat, { defaultProvider: "lm", defaultModel: "gamma" })).toEqual({
      kind: "ready",
      provider: "ol",
      model: "gamma",
    });
  });

  it("asks to pick (with a note) when a model is ambiguous across providers", () => {
    const r = resolveStartupChoice(cat, { defaultModel: "beta" });
    expect(r.kind).toBe("pick");
    if (r.kind === "pick") expect(r.note).toContain("multiple providers");
  });

  it("asks to pick (with a note) when a model is not found anywhere", () => {
    const r = resolveStartupChoice(cat, { requestedModel: "nope" });
    expect(r.kind).toBe("pick");
    if (r.kind === "pick") expect(r.note).toContain("not found");
  });

  it("lets --model override default_model", () => {
    expect(resolveStartupChoice(cat, { requestedModel: "alpha", defaultModel: "gamma" })).toEqual({
      kind: "ready",
      provider: "lm",
      model: "alpha",
    });
  });
});
