import { expect, test } from "bun:test";
import type { ProviderType } from "../../src/config/types";
import { detectLocalProviders } from "../../src/setup/first-run";

test("detects only servers that return models", async () => {
  const probe = async (type: ProviderType) => {
    if (type === "lmstudio") return ["m1", "m2"];
    throw new Error("connection refused");
  };
  const r = await detectLocalProviders({ probe });
  expect(r).toEqual([{ type: "lmstudio", baseUrl: "http://localhost:1234", models: ["m1", "m2"] }]);
});

test("none up → []", async () => {
  const r = await detectLocalProviders({
    probe: async () => {
      throw new Error("down");
    },
  });
  expect(r).toEqual([]);
});

test("all up → all in well-known port order", async () => {
  const candidates: Array<[string, string]> = [];
  const r = await detectLocalProviders({
    probe: async (type, baseUrl) => {
      candidates.push([type, baseUrl]);
      return ["x"];
    },
  });
  expect(r.map((d) => d.type)).toEqual(["lmstudio", "ollama", "llama.cpp"]);
  expect(candidates).toEqual([
    ["lmstudio", "http://localhost:1234"],
    ["ollama", "http://localhost:11434"],
    ["llama.cpp", "http://localhost:8080"],
  ]);
});

test("a server returning no models is excluded", async () => {
  const probe = async (type: ProviderType) => (type === "lmstudio" ? ["x"] : []);
  const r = await detectLocalProviders({ probe });
  expect(r.map((d) => d.type)).toEqual(["lmstudio"]);
});

test("a hanging probe is excluded via the timeout", async () => {
  const probe = async (type: ProviderType) =>
    type === "lmstudio" ? ["x"] : new Promise<string[]>(() => {});
  const r = await detectLocalProviders({ probe, timeoutMs: 50 });
  expect(r.map((d) => d.type)).toEqual(["lmstudio"]);
});
