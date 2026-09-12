import { describe, expect, it } from "bun:test";
import { CleetusError } from "../../src/lib/errors";
import type { Provider } from "../../src/providers/types";
import { Embedder } from "../../src/vector/embedder";
import { VectorService } from "../../src/vector/service";

function fakeEmbedder(): Embedder {
  const provider: Provider = {
    listModels: async () => [],
    chat: async function* () {},
    embed: async (text) => [text.length, text.includes("z") ? 1 : 0],
  };
  return new Embedder(provider, "m1");
}

const mkService = (embedder: Embedder | null) =>
  new VectorService({ projectDbPath: ":memory:", globalDbPath: ":memory:", embedder });

describe("VectorService", () => {
  it("reports enabled based on embedder presence", () => {
    expect(mkService(null).enabled).toBe(false);
    expect(mkService(fakeEmbedder()).enabled).toBe(true);
  });

  it("throws EMBEDDINGS_DISABLED when not configured", async () => {
    await expect(mkService(null).index("project", "ns", [{ id: "1", text: "x" }])).rejects.toThrow(
      CleetusError,
    );
  });

  it("indexes and searches within a scope", async () => {
    const svc = mkService(fakeEmbedder());
    await svc.index("project", "code", [
      { id: "1", text: "z" },
      { id: "2", text: "aaaa" },
    ]);
    expect((await svc.search("project", "code", "z", 2))[0]!.id).toBe("1");
    svc.close();
  });

  it("keeps project and global scopes isolated", async () => {
    const svc = mkService(fakeEmbedder());
    await svc.index("project", "code", [{ id: "p", text: "z" }]);
    await svc.index("global", "code", [{ id: "g", text: "z" }]);
    expect((await svc.search("project", "code", "z", 10)).map((h) => h.id)).toEqual(["p"]);
    expect((await svc.search("global", "code", "z", 10)).map((h) => h.id)).toEqual(["g"]);
    svc.close();
  });
});
