import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

test("patched MCP HTTP adapter supports ESM/CJS exports and Bun HTTP requests", async () => {
  const require = createRequire(import.meta.url);
  expect(typeof require("@hono/node-server").serve).toBe("function");
  const app = new Hono();
  app.post("/probe", async (context) => context.json({ echo: await context.req.json() }));
  let server: ReturnType<typeof serve> | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
        resolve(info.port),
      );
      server.once("error", reject);
    });
    const response = await fetch(`http://127.0.0.1:${port}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "mcp-adapter-ok" }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ echo: { value: "mcp-adapter-ok" } });
  } finally {
    if (server) {
      const active = server;
      await new Promise<void>((resolve, reject) =>
        active.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});
