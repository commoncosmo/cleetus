import { describe, expect, test } from "bun:test";
import type { TransportFn, TransportResponse } from "../../../src/web/fetch";
import { resolved } from "../../../src/workflows/provenance";
import type { WorkflowStepError } from "../../../src/workflows/retry";
import { createHttpRequestStep } from "../../../src/workflows/steps/http-request";

function response(
  status: number,
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
): TransportResponse {
  return {
    status,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    text: async () => body,
    dispose() {},
  };
}

const permissions = {
  network: [{ host: "api.open-meteo.com", methods: ["GET"] }],
  commands: [],
  filesystem: { read: [], write: [] },
  model: false,
};

describe("http.request@1", () => {
  test("constructs the exact Open-Meteo request with encoded query values", async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    const transport: TransportFn = async (url, options) => {
      seen.push({ url: url.toString(), method: options.method });
      return response(200, '{"hourly":{"temperature_2m":[32]}}');
    };
    const step = createHttpRequestStep({ transport });
    const output = await step.execute(
      resolved({
        url: "https://api.open-meteo.com/v1/forecast",
        query: {
          latitude: 42.07225,
          longitude: -87.72284,
          hourly: "temperature_2m",
          label: "Wilmette IL",
        },
        response: "json",
      }),
      {
        signal: new AbortController().signal,
        runId: "run",
        workspace: "/work",
        permissions,
      },
    );
    expect(seen).toEqual([
      {
        url: "https://api.open-meteo.com/v1/forecast?hourly=temperature_2m&label=Wilmette+IL&latitude=42.07225&longitude=-87.72284",
        method: "GET",
      },
    ]);
    expect(output.value).toMatchObject({
      status: 200,
      body: { hourly: { temperature_2m: [32] } },
    });
    expect(output.provenance.untrusted).toBe(true);
  });

  test("revalidates redirects against the approved host envelope", async () => {
    const step = createHttpRequestStep({
      transport: async () => response(302, "", { location: "https://evil.example/data" }),
    });
    await expect(
      step.execute(
        resolved({
          url: "https://api.open-meteo.com/start",
        }),
        {
          signal: new AbortController().signal,
          runId: "run",
          workspace: "/work",
          permissions,
        },
      ),
    ).rejects.toThrow("outside the approved");
  });

  test("classifies status and JSON failures without exposing headers or bodies in previews", async () => {
    const throttled = createHttpRequestStep({
      transport: async () => response(429, "secret response"),
    });
    await expect(
      throttled.execute(
        resolved({
          url: "https://api.open-meteo.com/data",
          headers: { authorization: "Bearer secret-value" },
        }),
        {
          signal: new AbortController().signal,
          runId: "run",
          workspace: "/work",
          permissions,
        },
      ),
    ).rejects.toMatchObject({ errorClass: "http_429" } satisfies Partial<WorkflowStepError>);
    expect(
      throttled.preview({
        url: "https://api.open-meteo.com/data",
        headers: { authorization: "Bearer secret-value" },
      }),
    ).not.toContain("secret-value");

    const invalid = createHttpRequestStep({
      transport: async () => response(200, "not-json"),
    });
    await expect(
      invalid.execute(
        resolved({
          url: "https://api.open-meteo.com/data",
          response: "json",
        }),
        {
          signal: new AbortController().signal,
          runId: "run",
          workspace: "/work",
          permissions,
        },
      ),
    ).rejects.toMatchObject({ errorClass: "invalid_json" });
  });

  test("does not permit side-effect retries without idempotency or acknowledgement", () => {
    const step = createHttpRequestStep();
    expect(
      step.classify({
        url: "https://api.open-meteo.com/data",
        method: "POST",
      }).retryable,
    ).toEqual([]);
    expect(
      step.classify({
        url: "https://api.open-meteo.com/data",
        method: "POST",
        idempotency_key: "stable",
      }).retryable,
    ).toContain("http_5xx");
  });
});
