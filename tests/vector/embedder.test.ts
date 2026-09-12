import { describe, expect, it } from "bun:test";
import { CleetusError } from "../../src/lib/errors";
import type { Provider } from "../../src/providers/types";
import { Embedder } from "../../src/vector/embedder";

function fakeProvider(embed: (text: string, model?: string) => Promise<number[]>): Provider {
  return {
    listModels: async () => [],
    chat: async function* () {},
    embed,
  };
}

describe("Embedder", () => {
  it("embeds a single text and returns a Float32Array", async () => {
    const e = new Embedder(
      fakeProvider(async (t) => [t.length, 0]),
      "m1",
    );
    const v = await e.embed("abc");
    expect(v).toBeInstanceOf(Float32Array);
    expect(Array.from(v)).toEqual([3, 0]);
    expect(e.model).toBe("m1");
  });

  it("embeds a batch preserving input order", async () => {
    const e = new Embedder(
      fakeProvider(async (t) => [t.length]),
      "m1",
    );
    const vs = await e.embedBatch(["a", "bb", "ccc", "dddd", "eeeee"]);
    expect(vs.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it("tags batch errors with the failing item index", async () => {
    const e = new Embedder(
      fakeProvider(async (t) => {
        if (t === "bad") throw new Error("boom");
        return [1];
      }),
      "m1",
    );
    await expect(e.embedBatch(["ok", "bad"])).rejects.toThrow(/item 1/);
  });

  it("preserves the original CleetusError code when an item fails", async () => {
    const e = new Embedder(
      fakeProvider(async (t) => {
        if (t === "bad") throw new CleetusError("PROVIDER_UNREACHABLE", "down");
        return [1];
      }),
      "m1",
    );
    await expect(e.embedBatch(["ok", "bad"])).rejects.toMatchObject({
      code: "PROVIDER_UNREACHABLE",
    });
  });
});
