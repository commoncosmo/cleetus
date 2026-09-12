import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LMStudioProvider } from "../../src/providers/lmstudio";

const originalFetch = globalThis.fetch;

interface FakeResponse {
  url: string;
  init: RequestInit;
}

let calls: FakeResponse[] = [];
let nextResponse: (url: string) => Response;

beforeEach(() => {
  calls = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(nextResponse(url));
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("LMStudioProvider.listModels", () => {
  it("reads /api/v0/models and surfaces the loaded context length", async () => {
    nextResponse = (url) =>
      url.includes("/api/v0/models")
        ? new Response(JSON.stringify({ data: [{ id: "qwen", loaded_context_length: 8192 }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("unexpected", { status: 404 });
    const p = new LMStudioProvider({ baseUrl: "http://h:1234" });
    const models = await p.listModels();
    expect(models).toEqual([{ id: "qwen", contextLength: 8192 }]);
    expect(calls[0]!.url).toBe("http://h:1234/api/v0/models");
  });

  it("falls back to /v1/models (id-only) when the native endpoint is unavailable", async () => {
    nextResponse = (url) =>
      url.includes("/api/v0/models")
        ? new Response("nope", { status: 404 })
        : new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    const p = new LMStudioProvider({ baseUrl: "http://h:1234" });
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
    expect(calls.some((c) => c.url === "http://h:1234/v1/models")).toBe(true);
  });
});

describe("LMStudioProvider.chat", () => {
  it("streams text deltas from SSE", async () => {
    const lines = `${[
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n")}\n\n`;
    nextResponse = () =>
      new Response(new Blob([lines]).stream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const p = new LMStudioProvider({ baseUrl: "http://h:1234" });
    const out: string[] = [];
    for await (const e of p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
      if (e.type === "text-delta") out.push(e.text);
    }
    expect(out.join("")).toBe("Hello");
  });

  it("emits tool-call event from delta tool_calls", async () => {
    const lines = `${[
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a"}' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ].join("\n\n")}\n\n`;
    nextResponse = () =>
      new Response(new Blob([lines]).stream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const p = new LMStudioProvider({ baseUrl: "http://h:1234" });
    const events = [];
    for await (const e of p.chat({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "read_file", description: "", parameters: {} }],
    })) {
      events.push(e);
    }
    const tc = events.find((e) => e.type === "tool-call");
    expect(tc).toBeTruthy();
    if (tc?.type === "tool-call") {
      expect(tc.call.name).toBe("read_file");
      expect(tc.call.args).toEqual({ path: "a" });
    }
  });

  it("surfaces the server's error message, not raw JSON, on a 400", async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          error: {
            message:
              'Invalid model identifier "zai-org/glm-47-flash". Please specify a valid downloaded model.',
            type: "invalid_request_error",
            code: "model_not_found",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    const p = new LMStudioProvider({ baseUrl: "http://h:1234" });
    let caught: Error | undefined;
    try {
      const events = [];
      for await (const e of p.chat({ model: "bad", messages: [{ role: "user", content: "hi" }] })) {
        events.push(e);
      }
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('Invalid model identifier "zai-org/glm-47-flash"');
    // never leak the JSON envelope
    expect(caught!.message).not.toContain("{");
    expect(caught!.message).not.toContain('"error"');
  });

  it("captures streaming usage and surfaces it on the finish event", async () => {
    const lines = `${[
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } })}`,
      "data: [DONE]",
    ].join("\n\n")}\n\n`;
    nextResponse = () =>
      new Response(new Blob([lines]).stream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const p = new LMStudioProvider({ baseUrl: "http://h:1234" });
    let finishEvent: { usage?: { input?: number; output?: number } } | undefined;
    for await (const e of p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
      if (e.type === "finish") finishEvent = e;
    }
    expect(finishEvent?.usage).toEqual({ input: 42, output: 7 });
  });

  it("accumulates tool-call arguments across multiple deltas", async () => {
    const lines = `${[
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write_file", arguments: '{"path":' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt",' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ].join("\n\n")}\n\n`;
    nextResponse = () =>
      new Response(new Blob([lines]).stream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const p = new LMStudioProvider({ baseUrl: "http://h:1234" });
    const events = [];
    for await (const e of p.chat({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "write_file", description: "", parameters: {} }],
    })) {
      events.push(e);
    }
    const tc = events.find((e) => e.type === "tool-call");
    expect(tc).toBeTruthy();
    if (tc?.type === "tool-call") {
      expect(tc.call.name).toBe("write_file");
      expect(tc.call.args).toEqual({ path: "a.txt", content: "hi" });
    }
  });

  it("emits reasoning-delta from delta.reasoning_content", async () => {
    const lines = `${[
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "let me think" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n")}\n\n`;
    nextResponse = () =>
      new Response(new Blob([lines]).stream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const p = new LMStudioProvider({ baseUrl: "http://h:1234" });
    const reasoning: string[] = [];
    const text: string[] = [];
    for await (const e of p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
      if (e.type === "reasoning-delta") reasoning.push(e.text);
      if (e.type === "text-delta") text.push(e.text);
    }
    expect(reasoning.join("")).toBe("let me think");
    expect(text.join("")).toBe("answer");
  });

  it("emits reasoning-delta from the delta.reasoning fallback field", async () => {
    const lines = `${[
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "fallback think" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n")}\n\n`;
    nextResponse = () =>
      new Response(new Blob([lines]).stream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const p = new LMStudioProvider({ baseUrl: "http://h:1234" });
    const reasoning: string[] = [];
    for await (const e of p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
      if (e.type === "reasoning-delta") reasoning.push(e.text);
    }
    expect(reasoning.join("")).toBe("fallback think");
  });

  it("captures the served model even when it rides only on the usage-only final chunk", async () => {
    const lines = `${[
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`,
      `data: ${JSON.stringify({ model: "actual-served", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n")}\n\n`;
    nextResponse = () =>
      new Response(new Blob([lines]).stream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const p = new LMStudioProvider({ baseUrl: "http://h:1234" });
    let served: string | undefined;
    for await (const e of p.chat({
      model: "requested-id",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (e.type === "finish") served = e.model;
    }
    expect(served).toBe("actual-served");
  });

  it("reports the served model on the finish event", async () => {
    const lines = `${[
      `data: ${JSON.stringify({ model: "gpt-oss-120b", choices: [{ delta: { content: "hi" } }] })}`,
      `data: ${JSON.stringify({ model: "gpt-oss-120b", choices: [{ finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n")}\n\n`;
    nextResponse = () =>
      new Response(new Blob([lines]).stream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const p = new LMStudioProvider({ baseUrl: "http://h:1234" });
    let served: string | undefined;
    for await (const e of p.chat({
      model: "requested-id",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (e.type === "finish") served = e.model;
    }
    expect(served).toBe("gpt-oss-120b");
  });
});
