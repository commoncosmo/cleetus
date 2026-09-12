import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { htmlToMarkdown } from "./convert";
import { type ResolveFn, SsrfBlockedError, type SsrfPolicy, assertUrlAllowed } from "./ssrf";

/**
 * Bun's global `fetch`. Still used by the web *search* backends, which call fixed,
 * trusted API endpoints (Brave/DDG) rather than attacker-controlled hosts — they
 * are out of scope for the SSRF pinning that `web_fetch` requires.
 */
export type FetchFn = typeof fetch;

export interface FetchResult {
  ok: boolean;
  contentType: string;
  body: string;
  finalUrl: string;
  error?: string;
}

/** A minimal, transport-agnostic response — enough for `fetchUrl` to decide what to do. */
export interface TransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  /** Read the body as UTF-8 text (bounded by an internal memory ceiling). */
  text(): Promise<string>;
  /** Discard the body without reading it (used for redirects and binary content). */
  dispose(): void;
}

export interface TransportOptions {
  policy: SsrfPolicy;
  resolve?: ResolveFn;
  signal?: AbortSignal;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  maxResponseBytes?: number;
  /** Extra CA to trust (test/enterprise use only). Never disables verification. */
  tlsCa?: string | Buffer;
}

/** Pluggable transport so tests can inject canned responses; defaults to `pinnedRequest`. */
export type TransportFn = (url: URL, opts: TransportOptions) => Promise<TransportResponse>;

export interface FetchOptions {
  policy: SsrfPolicy;
  maxBytes: number;
  signal?: AbortSignal;
  resolve?: ResolveFn;
  transport?: TransportFn;
}

const MAX_REDIRECTS = 5;
/** Hard memory ceiling for a single response body, independent of the smaller `maxBytes` text cap. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Build a DNS `lookup` hook that always resolves to `pinnedIp`. Handed to the
 * node HTTP client so the connection targets the exact IP that passed SSRF
 * validation — there is no second, unchecked resolution at connect time. SNI,
 * the `Host` header, and certificate validation still key off the URL hostname.
 */
function pinnedLookup(pinnedIp: string) {
  const family = isIP(pinnedIp) || 4;
  // Honor the dns.lookup callback contract: when the caller sets `{ all: true }`
  // it expects the array form, otherwise the scalar `(err, address, family)` form.
  // Bun (and modern Node, for happy-eyeballs) request `all: true`. Either way the
  // ONLY address we ever hand back is the pre-validated pinned IP — there is no
  // path to a second, unchecked resolution.
  // biome-ignore lint/suspicious/noExplicitAny: node's lookup callback is overloaded (scalar vs array)
  return (_host: string, options: any, cb?: any): void => {
    const callback = (typeof options === "function" ? options : cb) as (
      err: Error | null,
      ...rest: unknown[]
    ) => void;
    const all = typeof options === "object" && options !== null && options.all === true;
    if (all) callback(null, [{ address: pinnedIp, family }]);
    else callback(null, pinnedIp, family);
  };
}

/**
 * The real transport: validate the URL, pin the connection to the single
 * validated IP, and issue an HTTP(S) request that does not auto-follow redirects
 * (the caller re-validates each hop). Closes the DNS-rebinding/TOCTOU window that
 * Bun's global `fetch` leaves open by re-resolving the hostname at connect time.
 */
export async function pinnedRequest(url: URL, opts: TransportOptions): Promise<TransportResponse> {
  const pinnedIp = await assertUrlAllowed(url, opts.policy, opts.resolve);
  const client = url.protocol === "https:" ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets for SNI/Host

  return new Promise<TransportResponse>((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: opts.method ?? "GET",
        lookup: pinnedLookup(pinnedIp) as never,
        signal: opts.signal,
        ca: opts.tlsCa,
        headers: {
          "user-agent": "cleetus-web-fetch/1.0",
          accept: "text/html,text/*,*/*",
          // node's client (unlike fetch) doesn't auto-decompress; ask for identity.
          "accept-encoding": "identity",
          ...opts.headers,
        },
      },
      (res) => {
        const headers = {
          get: (name: string): string | null => {
            const v = res.headers[name.toLowerCase()];
            return Array.isArray(v) ? v.join(", ") : (v ?? null);
          },
        };
        resolve({
          status: res.statusCode ?? 0,
          headers,
          dispose: () => res.destroy(),
          text: () =>
            new Promise<string>((resText, rejText) => {
              const chunks: Buffer[] = [];
              let bytes = 0;
              let settled = false;
              // Settle exactly once: `error` must win over a later `close` so a
              // destroyed-with-error stream can't resolve with partial data.
              const done = (fn: () => void) => {
                if (settled) return;
                settled = true;
                fn();
              };
              res.on("data", (c: Buffer) => {
                bytes += c.length;
                const ceiling = Math.min(
                  MAX_RESPONSE_BYTES,
                  Math.max(1, opts.maxResponseBytes ?? MAX_RESPONSE_BYTES),
                );
                if (bytes <= ceiling) chunks.push(c);
                else {
                  done(() => rejText(new Error(`response exceeds ${ceiling} byte limit`)));
                  res.destroy();
                }
              });
              res.on("end", () => done(() => resText(Buffer.concat(chunks).toString("utf8"))));
              res.on("close", () => done(() => resText(Buffer.concat(chunks).toString("utf8"))));
              res.on("error", (e: Error) => done(() => rejText(e)));
            }),
        });
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

function capBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const truncated = Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${truncated}\n[truncated]`;
}

function isTextual(ct: string): "html" | "text" | "binary" {
  const c = ct.toLowerCase();
  if (c.includes("text/html") || c.includes("application/xhtml")) return "html";
  if (
    c.startsWith("text/") ||
    c.includes("application/json") ||
    c.includes("application/xml") ||
    c.includes("+json") ||
    c.includes("+xml")
  )
    return "text";
  return "binary";
}

export async function fetchUrl(rawUrl: string, opts: FetchOptions): Promise<FetchResult> {
  const transport = opts.transport ?? pinnedRequest;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      contentType: "",
      body: "",
      finalUrl: rawUrl,
      error: "refused: invalid URL",
    };
  }

  try {
    let current = url;
    let res: TransportResponse | null = null;
    // Each hop validates + pins inside the transport, so every redirect target is
    // independently re-checked against the SSRF policy and connected to its own
    // validated IP — no hop inherits a previously-validated address.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await transport(current, {
        policy: opts.policy,
        resolve: opts.resolve,
        signal: opts.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        res.dispose();
        if (!loc) {
          // A redirect with no Location header is a dead end; stop here.
          return {
            ok: false,
            contentType: "",
            body: "",
            finalUrl: current.toString(),
            error: `HTTP ${res.status} redirect without a Location header`,
          };
        }
        if (hop === MAX_REDIRECTS) {
          return {
            ok: false,
            contentType: "",
            body: "",
            finalUrl: current.toString(),
            error: "refused: too many redirects",
          };
        }
        current = new URL(loc, current); // resolve relative redirects; re-validated next loop
        continue;
      }
      break;
    }
    if (!res) {
      return {
        ok: false,
        contentType: "",
        body: "",
        finalUrl: current.toString(),
        error: "no response",
      };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status < 200 || res.status >= 300) {
      res.dispose();
      return {
        ok: false,
        contentType,
        body: "",
        finalUrl: current.toString(),
        error: `HTTP ${res.status}`,
      };
    }
    const kind = isTextual(contentType);
    if (kind === "binary") {
      const len = res.headers.get("content-length") ?? "unknown";
      res.dispose();
      return {
        ok: true,
        contentType,
        finalUrl: current.toString(),
        body: `(fetched ${contentType || "binary content"}, ${len} bytes; not rendered as text)`,
      };
    }
    const raw = await res.text();
    const text = kind === "html" ? htmlToMarkdown(raw) : raw;
    return {
      ok: true,
      contentType,
      finalUrl: current.toString(),
      body: capBytes(text, opts.maxBytes),
    };
  } catch (e) {
    const msg = e instanceof SsrfBlockedError ? e.message : `fetch failed: ${(e as Error).message}`;
    return { ok: false, contentType: "", body: "", finalUrl: rawUrl, error: msg };
  }
}
