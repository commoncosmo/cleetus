import { afterEach, describe, expect, it } from "bun:test";
import { CleetusError } from "../../src/lib/errors";
import { chatOpenAI } from "../../src/providers/openai-compat";
import type { StreamEvent } from "../../src/providers/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockStatus(status: number, body: string): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(body, { status, headers: { "content-type": "text/plain" } }),
    )) as unknown as typeof fetch;
}

async function drain(): Promise<void> {
  const stream = chatOpenAI(
    { baseUrl: "http://x" },
    { model: "m", messages: [{ role: "user", content: "hi" }] },
  );
  for await (const _ of stream) {
    // consume
  }
}

describe("chatOpenAI error retryability", () => {
  it("marks a mid-stream disconnect retryable without emitting buffered tool calls", async () => {
    const failure = new Error("The socket connection was closed unexpectedly.");
    let pulls = 0;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (pulls++ === 0) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    choices: [
                      {
                        delta: {
                          reasoning_content: "Preparing the next edit",
                          tool_calls: [
                            {
                              index: 0,
                              id: "partial",
                              function: { name: "write_file", arguments: '{"path":' },
                            },
                          ],
                        },
                      },
                    ],
                  })}\n\n`,
                ),
              );
            } else controller.error(failure);
          },
        }),
      )) as unknown as typeof fetch;
    const events: StreamEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of chatOpenAI(
        { baseUrl: "http://mock.invalid" },
        {
          model: "m",
          messages: [{ role: "user", content: "go" }],
        },
      ))
        events.push(event);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CleetusError);
    expect(caught).toMatchObject({ code: "PROVIDER_UNREACHABLE", retryable: true, cause: failure });
    expect(events.some((event) => event.type === "reasoning-delta")).toBe(true);
    expect(events.some((event) => event.type === "tool-call" || event.type === "finish")).toBe(
      false,
    );
  });

  it("preserves cancellation rather than classifying it as a retryable disconnect", async () => {
    const abort = new AbortController();
    const failure = new DOMException("Cancelled", "AbortError");
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            abort.abort(failure);
            controller.error(failure);
          },
        }),
      )) as unknown as typeof fetch;
    let caught: unknown;
    try {
      for await (const _ of chatOpenAI(
        { baseUrl: "http://mock.invalid" },
        {
          model: "m",
          messages: [],
          signal: abort.signal,
        },
      )) {
        /* consume */
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });

  it("marks a 5xx chat failure as retryable", async () => {
    mockStatus(
      500,
      'error parsing tool call: raw=\'{"name":"x","max?":??}\', err=invalid character \'?\'',
    );
    let caught: unknown;
    try {
      await drain();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CleetusError);
    expect((caught as CleetusError).code).toBe("PROVIDER_INVALID_RESPONSE");
    expect((caught as CleetusError).retryable).toBe(true);
  });

  it("marks a 4xx chat failure as non-retryable", async () => {
    mockStatus(400, "bad request");
    let caught: unknown;
    try {
      await drain();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CleetusError);
    expect((caught as CleetusError).retryable).toBe(false);
  });
});
