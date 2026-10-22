import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { OllamaProvider } from "../../src/providers/ollama";
import { Embedder } from "../../src/vector/embedder";

describe("embedding request lifetimes", () => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  let deadline: ReturnType<typeof spyOn>;
  let server: ReturnType<typeof Bun.serve>;
  let respond: () => Response | Promise<Response>;
  let provider: OllamaProvider;
  beforeEach(() => {
    deadline = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(30_000);
      return realTimeout(40);
    });
    respond = () => new Promise<Response>(() => {});
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => respond() });
    provider = new OllamaProvider({ baseUrl: `http://127.0.0.1:${server.port}` });
  });
  afterEach(() => {
    server?.stop(true);
    deadline?.mockRestore();
  });

  it("aborts a query embedding when the server never sends headers", async () => {
    await expect(new Embedder(provider, "embedding-model").embed("query")).rejects.toThrow(
      /timed out/i,
    );
  });

  it("keeps the deadline active while reading a stalled JSON body", async () => {
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":['));
          },
        }),
      );
    await expect(provider.embed("query", "model")).rejects.toThrow();
  });

  it("forwards caller cancellation through Embedder and the provider adapter", async () => {
    const controller = new AbortController();
    const request = new Embedder(provider, "model").embed("query", controller.signal);
    controller.abort();
    await expect(request).rejects.toThrow(/abort/i);
  });

  it("does not send a batch when it is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const embed = spyOn(provider, "embed");
    await expect(
      new Embedder(provider, "model").embedBatch(["first", "second"], controller.signal),
    ).rejects.toThrow();
    expect(embed).not.toHaveBeenCalled();
    embed.mockRestore();
  });
});
