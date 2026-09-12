import type { TransportFn, TransportResponse } from "../../web/fetch";
import { pinnedRequest } from "../../web/fetch";
import type { ResolveFn, SsrfPolicy } from "../../web/ssrf";
import { workflowPermissionsContain } from "../permissions";
import { resolved } from "../provenance";
import { WorkflowStepError } from "../retry";
import type { WorkflowStepType } from "../step-registry";
import type { JsonValue, WorkflowRetryClass } from "../types";

interface HttpRequestInput {
  url: string;
  method?: string;
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  headers?: Record<string, string>;
  body?: JsonValue | string;
  expected_status?: number[];
  expected_content_type?: string;
  response?: "json" | "text";
  max_response_bytes?: number;
  idempotency_key?: string;
  allow_unsafe_retry?: boolean;
}

export interface HttpRequestStepDependencies {
  transport?: TransportFn;
  policy?: SsrfPolicy;
  resolve?: ResolveFn;
}

const MAX_REDIRECTS = 5;

function methodOf(input: HttpRequestInput): string {
  return (input.method ?? "GET").toUpperCase();
}

function requestUrl(input: HttpRequestInput): URL {
  const url = new URL(input.url);
  for (const [name, raw] of Object.entries(input.query ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      url.searchParams.append(name, String(value));
    }
  }
  return url;
}

function previewUrl(input: HttpRequestInput): string {
  const url = requestUrl(input);
  const sensitiveName = /(?:api[-_]?key|auth|password|secret|signature|token)/iu;
  for (const [name, value] of [...url.searchParams.entries()]) {
    if (sensitiveName.test(name) || /\$secrets(?:\.|\{)/u.test(value)) {
      url.searchParams.set(name, "<redacted>");
    }
  }
  const query = url.search.length > 1_024 ? `${url.search.slice(0, 1_024)}…` : url.search;
  return `${url.origin}${url.pathname}${query}`;
}

function retryableFor(method: string, input: HttpRequestInput): WorkflowRetryClass[] {
  if (method === "GET" || method === "HEAD" || input.idempotency_key || input.allow_unsafe_retry) {
    return ["timeout", "connection_error", "http_429", "http_5xx"];
  }
  return [];
}

function classification(input: HttpRequestInput) {
  const url = requestUrl(input);
  const method = methodOf(input);
  return {
    effect:
      method === "GET" || method === "HEAD"
        ? ("read-only" as const)
        : input.idempotency_key
          ? ("idempotent" as const)
          : ("side-effecting" as const),
    permissions: {
      network: [{ host: url.hostname.toLowerCase(), methods: [method] }],
    },
    retryable: retryableFor(method, input),
  };
}

function errorForStatus(status: number): WorkflowStepError {
  if (status === 429) return new WorkflowStepError("HTTP 429", "http_429", true);
  if (status >= 500) return new WorkflowStepError(`HTTP ${status}`, "http_5xx", true);
  return new WorkflowStepError(`HTTP ${status}`, "http_status");
}

function boundedHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const entries = Object.entries(input ?? {});
  if (entries.length > 64) throw new Error("HTTP request has too many headers");
  let bytes = 0;
  const out: Record<string, string> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/u.test(name))
      throw new Error(`invalid HTTP header '${rawName}'`);
    if (["host", "connection", "content-length", "transfer-encoding"].includes(name)) {
      throw new Error(`HTTP header '${rawName}' is controlled by the transport`);
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > 32_768) throw new Error("HTTP request headers exceed the byte limit");
    out[name] = value;
  }
  return out;
}

async function readResponse(
  response: TransportResponse,
  input: HttpRequestInput,
  finalUrl: URL,
): Promise<JsonValue> {
  const expectedStatuses = input.expected_status ?? [200];
  if (!expectedStatuses.includes(response.status)) {
    response.dispose();
    throw errorForStatus(response.status);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (
    input.expected_content_type &&
    !contentType.toLowerCase().includes(input.expected_content_type.toLowerCase())
  ) {
    response.dispose();
    throw new WorkflowStepError(`unexpected content type '${contentType}'`, "content_type");
  }
  const text = await response.text();
  let body: JsonValue = text;
  if (input.response === "json" || contentType.toLowerCase().includes("json")) {
    try {
      body = JSON.parse(text) as JsonValue;
    } catch {
      throw new WorkflowStepError("HTTP response is not valid JSON", "invalid_json");
    }
  }
  return {
    status: response.status,
    content_type: contentType,
    final_url: finalUrl.toString(),
    body,
  };
}

export function createHttpRequestStep(
  dependencies: HttpRequestStepDependencies = {},
): WorkflowStepType {
  const transport = dependencies.transport ?? pinnedRequest;
  const policy = dependencies.policy ?? { allowLocalhost: false };
  return {
    name: "http.request",
    version: 1,
    defaultTimeoutMs: 30_000,
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", maxLength: 8_192 },
        method: { type: "string", pattern: "^[A-Za-z]+$" },
        query: {
          type: "object",
          additionalProperties: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              {
                type: "array",
                items: {
                  anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
                },
              },
            ],
          },
        },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: {},
        expected_status: { type: "array", items: { type: "integer", minimum: 100, maximum: 599 } },
        expected_content_type: { type: "string" },
        response: { enum: ["json", "text"] },
        max_response_bytes: { type: "integer", minimum: 1, maximum: 8_388_608 },
        idempotency_key: { type: "string", minLength: 1 },
        allow_unsafe_retry: { type: "boolean" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["status", "content_type", "final_url", "body"],
      properties: {
        status: { type: "integer" },
        content_type: { type: "string" },
        final_url: { type: "string" },
        body: {},
      },
      additionalProperties: false,
    },
    classify(value) {
      return classification(value as unknown as HttpRequestInput);
    },
    preview(value) {
      const input = value as unknown as HttpRequestInput;
      return `${methodOf(input)} ${previewUrl(input)} (headers/body redacted)`;
    },
    async execute(input, context) {
      const value = input.value as unknown as HttpRequestInput;
      const method = methodOf(value);
      let current = requestUrl(value);
      const headers = boundedHeaders(value.headers);
      if (value.idempotency_key) headers["idempotency-key"] = value.idempotency_key;
      const body =
        value.body === undefined
          ? undefined
          : typeof value.body === "string"
            ? value.body
            : JSON.stringify(value.body);
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const required = {
          network: [{ host: current.hostname.toLowerCase(), methods: [method] }],
        };
        if (!workflowPermissionsContain(context.permissions ?? {}, required, context.workspace)) {
          throw new WorkflowStepError(
            `redirect/request host '${current.hostname}' is outside the approved network grant`,
            "permission_denied",
          );
        }
        let response: TransportResponse;
        try {
          response = await transport(current, {
            policy,
            resolve: dependencies.resolve,
            signal: context.signal,
            method,
            headers,
            body,
            maxResponseBytes: value.max_response_bytes ?? 1_048_576,
          });
        } catch (error) {
          if (context.signal.aborted)
            throw new WorkflowStepError("HTTP request cancelled", "cancelled");
          throw new WorkflowStepError(
            `HTTP request failed: ${(error as Error).message}`,
            "connection_error",
            true,
          );
        }
        if (response.status < 300 || response.status >= 400) {
          return resolved(await readResponse(response, value, current), {
            untrusted: true,
            origins: [`http:${current.hostname}`],
          });
        }
        const location = response.headers.get("location");
        response.dispose();
        if (!location)
          throw new WorkflowStepError("redirect has no Location header", "http_redirect");
        if (hop === MAX_REDIRECTS) {
          throw new WorkflowStepError("too many HTTP redirects", "http_redirect");
        }
        current = new URL(location, current);
      }
      throw new WorkflowStepError("HTTP request produced no response", "connection_error", true);
    },
  };
}
