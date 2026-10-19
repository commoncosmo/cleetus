import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pumpStdin } from "../../src/acp/server";
import { AcpTransport } from "../../src/acp/transport";

interface WireMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

for (const mode of ["terminal", "acp"] as const) {
  test(`explicit vLLM config completes a native read_file round trip through ${mode}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cleetus-vllm-")));
    const project = join(root, "project");
    const configDir = join(root, "config");
    await mkdir(project);
    await mkdir(configDir);
    await writeFile(join(project, "README.md"), "vLLM fixture file contents");
    const requests: {
      path: string;
      authorization: string | null;
      body?: { model: string; messages: WireMessage[]; tools?: unknown[] };
    }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const authorization = req.headers.get("authorization");
        if (authorization !== "Bearer fixture-key")
          return new Response("Unauthorized", { status: 401 });
        if (path === "/v1/models") {
          requests.push({ path, authorization });
          return Response.json({
            data: [{ id: "qwen2.5-7b-instruct", owned_by: "vllm", max_model_len: 32768 }],
          });
        }
        if (path !== "/v1/chat/completions") return new Response("Unknown route", { status: 404 });
        const body = (await req.json()) as NonNullable<(typeof requests)[number]["body"]>;
        requests.push({ path, authorization, body });
        const hasResult = body.messages.some((m) => m.role === "tool");
        const chunks: Record<string, unknown>[] = hasResult
          ? [
              {
                choices: [
                  {
                    delta: { content: "The fixture says: vLLM fixture file contents" },
                    finish_reason: "stop",
                  },
                ],
              },
            ]
          : [
              { choices: [{ delta: { reasoning: "Read the requested file" } }] },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "vllm-read",
                          type: "function",
                          function: { name: "read_file", arguments: '{"path":' },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                choices: [
                  {
                    delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] },
                    finish_reason: "tool_calls",
                  },
                ],
              },
            ];
        chunks.push({
          choices: [],
          usage: { prompt_tokens: 24, completion_tokens: 12 },
        });
        return new Response(
          `${chunks.map((c) => `data: ${JSON.stringify({ model: "qwen2.5-7b-instruct", ...c })}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    await writeFile(
      join(configDir, "config.yaml"),
      `providers:\n  gpu:\n    type: vllm\n    base_url: http://127.0.0.1:${server.port}\n    api_key: fixture-key\ndefault_provider: gpu\ndefault_model: qwen2.5-7b-instruct\nsandbox:\n  backend: none\n`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../src/bin/cleetus.ts"),
        ...(mode === "acp" ? ["acp"] : []),
        "--config-dir",
        configDir,
        ...(mode === "terminal" ? ["Use read_file to read README.md, then summarize it."] : []),
      ],
      {
        cwd: project,
        env: { ...process.env, HOME: root },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = new Response(child.stderr).text();
    let pump: Promise<void> | undefined;
    try {
      if (mode === "terminal") {
        child.stdin.end();
        const stdout = new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        expect(await stdout).toContain("The fixture says: vLLM fixture file contents");
      } else {
        const client = new AcpTransport({
          write: (line) => {
            child.stdin.write(line);
          },
          requestTimeoutMs: 10_000,
        });
        client.onRequest("session/request_permission", async () => ({
          outcome: { outcome: "selected", optionId: "allow_once" },
        }));
        pump = pumpStdin(client, child.stdout as unknown as AsyncIterable<Uint8Array>);
        await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        const session = (await client.request("session/new", { cwd: project })) as {
          sessionId: string;
        };
        expect(
          await client.request("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Use read_file to read README.md, then summarize it." }],
          }),
        ).toMatchObject({ stopReason: "end_turn" });
        child.stdin.end();
        expect(await child.exited).toBe(0);
      }
      expect(await stderr).not.toContain("PROVIDER_INVALID");
      expect(requests.some((r) => r.path === "/v1/models")).toBe(true);
      const chats = requests.filter((r) => r.body).map((r) => r.body!);
      expect(chats).toHaveLength(2);
      expect(chats[0]?.model).toBe("qwen2.5-7b-instruct");
      expect(chats[0]?.tools?.length).toBeGreaterThan(0);
      expect(chats[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          tool_calls: [
            expect.objectContaining({
              id: "vllm-read",
              function: { name: "read_file", arguments: '{"path":"README.md"}' },
            }),
          ],
        }),
      );
      expect(chats[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "vllm-read",
          content: expect.stringContaining("vLLM fixture file contents"),
        }),
      );
    } finally {
      child.kill();
      await child.exited;
      await pump;
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}
