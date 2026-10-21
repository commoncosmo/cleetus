import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { fetchCatalog } from "../../src/providers/catalog";
import { LlamaCppProvider } from "../../src/providers/llama-cpp";
import { LMStudioProvider } from "../../src/providers/lmstudio";
import {
  fetchLlamaCppProps,
  fetchOllamaModelContext,
  fetchOllamaVision,
} from "../../src/providers/native-context";
import { OllamaProvider } from "../../src/providers/ollama";
import { OMLXProvider } from "../../src/providers/omlx";
import { ProviderRegistry } from "../../src/providers/registry";
import { resolveStartupChoice } from "../../src/providers/startup";

// Use real HTTP and real aborts, shortening only the production deadline. This catches
// both a server that never sends headers and one that stalls while sending its body.
describe("provider metadata deadlines", () => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  let deadline: ReturnType<typeof spyOn>;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let respond: (request: Request) => Response | Promise<Response>;

  beforeEach(() => {
    deadline = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(5_000);
      return realTimeout(40);
    });
    respond = () => new Promise<Response>(() => {});
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => respond(request),
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server?.stop(true);
    deadline?.mockRestore();
  });

  it("finishes catalog discovery and offers healthy models when other servers hang", async () => {
    respond = (request) =>
      new URL(request.url).pathname === "/healthy/v1/models"
        ? Response.json({ data: [{ id: "available" }] })
        : new Promise<Response>(() => {});
    const registry = new ProviderRegistry();
    registry.register("offline-ollama", new OllamaProvider({ baseUrl }));
    registry.register("offline-lmstudio", new LMStudioProvider({ baseUrl }));
    registry.register("offline-llamacpp", new LlamaCppProvider({ baseUrl }));
    registry.register("healthy", new OMLXProvider({ baseUrl: `${baseUrl}/healthy` }));

    const catalog = await fetchCatalog(registry);
    expect(catalog.slice(0, 3).every((entry) => entry.models.length === 0 && entry.error)).toBe(
      true,
    );
    expect(catalog[3]).toEqual({ provider: "healthy", models: ["available"] });
    expect(
      resolveStartupChoice(catalog, {
        defaultProvider: "offline-ollama",
        defaultModel: "unavailable",
      }).kind,
    ).toBe("pick");
  });

  it("also aborts model listing when headers arrive but the JSON body stalls", async () => {
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":['));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    await expect(new OMLXProvider({ baseUrl }).listModels()).rejects.toThrow();
  });

  it("keeps Ollama model IDs when the advisory loaded-context endpoint hangs", async () => {
    respond = (request) =>
      new URL(request.url).pathname === "/v1/models"
        ? Response.json({ data: [{ id: "available" }] })
        : new Promise<Response>(() => {});
    expect(await new OllamaProvider({ baseUrl }).listModels()).toEqual([{ id: "available" }]);
  });

  it("bounds context, vision, and readiness probes before the first turn", async () => {
    const [context, vision, warnings] = await Promise.all([
      fetchOllamaModelContext({ baseUrl }, "model"),
      fetchOllamaVision({ baseUrl }, "model"),
      new LlamaCppProvider({ baseUrl }).readinessWarnings("model"),
    ]);
    expect(context).toBeUndefined();
    expect(vision).toBe("unknown");
    expect(warnings).toEqual([]);
    await expect(fetchLlamaCppProps({ baseUrl }, "model")).rejects.toThrow();
  });
});
