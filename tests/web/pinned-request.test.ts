import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { pinnedRequest } from "../../src/web/fetch";
import { SsrfBlockedError } from "../../src/web/ssrf";

// Throwaway self-signed cert/key for CN=secure.test (SAN: secure.test), valid ~100y.
// Used only to drive a loopback TLS server in these tests; not a real secret.
const cert = readFileSync(new URL("./fixtures/secure-test-cert.pem", import.meta.url));
const key = readFileSync(new URL("./fixtures/secure-test-key.pem", import.meta.url));

async function startHttp(
  handler: http.RequestListener,
): Promise<{ port: number; connections: number; close: () => void }> {
  const state = { connections: 0 };
  const server = http.createServer(handler);
  server.on("connection", () => {
    state.connections++;
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    get connections() {
      return state.connections;
    },
    close: () => server.close(),
  };
}

async function startHttps(
  handler: http.RequestListener,
): Promise<{ port: number; close: () => void }> {
  const server = https.createServer({ cert, key }, handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => server.close() };
}

describe("pinnedRequest", () => {
  it("sends a trusted caller's exact method, bounded headers, and body", async () => {
    const srv = await startHttp((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            header: req.headers["x-workflow"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
    });
    try {
      const r = await pinnedRequest(new URL(`http://example.test:${srv.port}/submit`), {
        policy: { allowLocalhost: true },
        resolve: async () => ["127.0.0.1"],
        method: "POST",
        headers: { "x-workflow": "strict" },
        body: '{"value":1}',
      });
      expect(JSON.parse(await r.text())).toEqual({
        method: "POST",
        header: "strict",
        body: '{"value":1}',
      });
    } finally {
      srv.close();
    }
  });

  it("enforces a caller-selected response memory ceiling", async () => {
    const srv = await startHttp((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("a".repeat(1_000));
    });
    try {
      const r = await pinnedRequest(new URL(`http://example.test:${srv.port}/large`), {
        policy: { allowLocalhost: true },
        resolve: async () => ["127.0.0.1"],
        maxResponseBytes: 10,
      });
      await expect(r.text()).rejects.toThrow("exceeds 10 byte");
    } finally {
      srv.close();
    }
  });

  it("connects to the validated pinned IP and preserves the original Host header", async () => {
    const srv = await startHttp((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`host=${req.headers.host}`);
    });
    try {
      // Hostname resolves (via our stub) to loopback; we pin and connect there.
      const r = await pinnedRequest(new URL(`http://example.test:${srv.port}/`), {
        policy: { allowLocalhost: true },
        resolve: async () => ["127.0.0.1"],
      });
      expect(r.status).toBe(200);
      // Host header is the original hostname, not the pinned IP.
      expect(await r.text()).toBe(`host=example.test:${srv.port}`);
    } finally {
      srv.close();
    }
  });

  it("refuses a blocked resolved address WITHOUT opening a connection (rebinding defense)", async () => {
    const srv = await startHttp((_req, res) => res.end("should not reach"));
    try {
      // The validator resolves to a private IP → refuse before any socket is opened.
      // There is no second, unchecked resolution that could reach the loopback server.
      await expect(
        pinnedRequest(new URL(`http://evil.test:${srv.port}/`), {
          policy: { allowLocalhost: false },
          resolve: async () => ["10.0.0.5"],
        }),
      ).rejects.toThrow(SsrfBlockedError);
      expect(srv.connections).toBe(0);
    } finally {
      srv.close();
    }
  });

  it("validates the TLS cert against the hostname while pinned to a loopback IP", async () => {
    const srv = await startHttps((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`ok host=${req.headers.host}`);
    });
    try {
      const r = await pinnedRequest(new URL(`https://secure.test:${srv.port}/`), {
        policy: { allowLocalhost: true },
        resolve: async () => ["127.0.0.1"],
        tlsCa: cert,
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("ok host=secure.test");
    } finally {
      srv.close();
    }
  });

  it("rejects when the hostname does not match the cert, even though the IP is pinned", async () => {
    const srv = await startHttps((_req, res) => res.end("ok"));
    try {
      // Cert is for secure.test; connecting as wrong.test must fail cert validation —
      // proving validation keys off the hostname, not the pinned connect IP.
      await expect(
        pinnedRequest(new URL(`https://wrong.test:${srv.port}/`), {
          policy: { allowLocalhost: true },
          resolve: async () => ["127.0.0.1"],
          tlsCa: cert,
        }),
      ).rejects.toThrow(/ALTNAME|altname|certificate|hostname/i);
    } finally {
      srv.close();
    }
  });
});
