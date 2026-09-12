import { describe, expect, it } from "bun:test";
import { type TransportFn, type TransportResponse, fetchUrl } from "../../src/web/fetch";
import { SsrfBlockedError } from "../../src/web/ssrf";

const policy = { allowLocalhost: false };

function res(
  body: string,
  headers: Record<string, string>,
  status = 200,
  onDispose?: () => void,
): TransportResponse {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
    text: async () => body,
    dispose: () => onDispose?.(),
  };
}

/** Transport that returns one canned response regardless of URL. */
const constTransport =
  (r: TransportResponse): TransportFn =>
  async () =>
    r;

const opts = (transport: TransportFn) => ({ policy, maxBytes: 1000, transport });

describe("fetchUrl", () => {
  it("converts HTML to markdown", async () => {
    const r = await fetchUrl(
      "https://example.com/",
      opts(constTransport(res("<h1>Hi</h1>", { "content-type": "text/html" }))),
    );
    expect(r.ok).toBe(true);
    expect(r.body).toContain("# Hi");
  });

  it("passes JSON through unchanged", async () => {
    const r = await fetchUrl(
      "https://example.com/api",
      opts(constTransport(res('{"a":1}', { "content-type": "application/json" }))),
    );
    expect(r.ok).toBe(true);
    expect(r.body).toContain('{"a":1}');
  });

  it("returns a note for binary content without reading the body", async () => {
    let read = false;
    let disposed = false;
    const binary: TransportResponse = {
      status: 200,
      headers: {
        get: (n: string) => (n.toLowerCase() === "content-type" ? "application/pdf" : null),
      },
      text: async () => {
        read = true;
        return "%PDF-1.4 binary";
      },
      dispose: () => {
        disposed = true;
      },
    };
    const r = await fetchUrl("https://example.com/f.pdf", opts(constTransport(binary)));
    expect(r.ok).toBe(true);
    expect(r.body).toContain("application/pdf");
    expect(r.body).not.toContain("%PDF-1.4 binary");
    expect(read).toBe(false); // body discarded via dispose(), never read
    expect(disposed).toBe(true);
  });

  it("caps oversized bodies", async () => {
    const big = "a".repeat(5000);
    const r = await fetchUrl("https://example.com/big", {
      policy,
      maxBytes: 100,
      transport: constTransport(res(big, { "content-type": "text/plain" })),
    });
    expect(r.ok).toBe(true);
    expect(r.body.length).toBeLessThan(big.length);
    expect(r.body).toContain("[truncated]");
  });

  it("fails on non-2xx", async () => {
    const r = await fetchUrl(
      "https://example.com/missing",
      opts(constTransport(res("nope", { "content-type": "text/plain" }, 404))),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("404");
  });

  it("propagates an SSRF refusal from the transport", async () => {
    const transport: TransportFn = async () => {
      throw new SsrfBlockedError(
        "refused: 127.0.0.1 resolves to a blocked address (127.0.0.1, loopback)",
      );
    };
    const r = await fetchUrl("http://127.0.0.1/", opts(transport));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("refused");
  });

  it("follows a redirect and re-invokes the transport for each hop", async () => {
    const seen: string[] = [];
    const transport: TransportFn = async (url) => {
      seen.push(url.toString());
      if (url.toString() === "https://example.com/start") {
        return res("", { location: "https://example.com/dest" }, 302);
      }
      return res("<h1>Done</h1>", { "content-type": "text/html" });
    };
    const r = await fetchUrl("https://example.com/start", opts(transport));
    expect(r.ok).toBe(true);
    expect(r.body).toContain("# Done");
    expect(r.finalUrl).toBe("https://example.com/dest");
    // Each hop went through the (validating, pinning) transport independently.
    expect(seen).toEqual(["https://example.com/start", "https://example.com/dest"]);
  });

  it("stops on a redirect that has no Location header", async () => {
    const r = await fetchUrl("https://example.com/nowhere", opts(constTransport(res("", {}, 302))));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("without a Location header");
  });

  it("refuses after too many redirects", async () => {
    let n = 0;
    const transport: TransportFn = async () => {
      n++;
      return res("", { location: `https://example.com/r${n}` }, 302);
    };
    const r = await fetchUrl("https://example.com/loop", opts(transport));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("too many redirects");
  });
});
