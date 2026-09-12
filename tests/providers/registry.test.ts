import { describe, expect, it } from "bun:test";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider } from "../../src/providers/types";

class FakeProvider implements Provider {
  constructor(public readonly name: string) {}
  async listModels() {
    return [{ id: `${this.name}-model` }];
  }
  async *chat() {
    yield { type: "text-delta" as const, text: "" };
  }
  async embed() {
    return [0];
  }
}

describe("ProviderRegistry", () => {
  it("registers and retrieves providers by name", () => {
    const reg = new ProviderRegistry();
    const p = new FakeProvider("lm");
    reg.register("lm", p);
    expect(reg.get("lm")).toBe(p);
  });

  it("throws CleetusError when provider not found", () => {
    const reg = new ProviderRegistry();
    expect(() => reg.get("nope")).toThrow(/PROVIDER_UNREACHABLE/);
  });

  it("lists registered names", () => {
    const reg = new ProviderRegistry();
    reg.register("a", new FakeProvider("a"));
    reg.register("b", new FakeProvider("b"));
    expect(reg.names().sort()).toEqual(["a", "b"]);
  });
});
