import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pumpStdin } from "../../src/acp/server";
import { AcpTransport } from "../../src/acp/transport";
import { approveProjectConfiguration } from "../../src/security/project-trust";

for (const scenario of [
  "default",
  "fuckit",
  "bash",
  "deny",
  "plan",
  "metadata",
  "config-only",
] as const) {
  test(`ACP CLI tool execution: ${scenario}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cleetus-acp-fuckit-")));
    const project = join(root, "project");
    const configDir = join(root, "config");
    await mkdir(project);
    await mkdir(configDir);
    const enabled = scenario !== "default" && scenario !== "config-only";
    const target =
      scenario === "fuckit"
        ? join(root, "outside.txt")
        : join(project, scenario === "metadata" ? ".git/config" : "result.txt");
    let toolCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/models")) {
          return Response.json({ data: [{ id: "test-model", loaded_context_length: 32768 }] });
        }
        if (path === "/v1/chat/completions") {
          const body = (await req.json()) as { messages: { role: string }[] };
          const callTool = body.messages.at(-1)?.role === "user";
          if (callTool) toolCalls++;
          const chunks = callTool
            ? [
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: `write-${toolCalls}`,
                            function: {
                              name: scenario === "bash" ? "bash" : "write_file",
                              arguments: JSON.stringify(
                                scenario === "bash"
                                  ? {
                                      command:
                                        process.platform === "win32"
                                          ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'result.txt'),'ACP test')"
                                          : "printf 'ACP test' > result.txt",
                                    }
                                  : { path: target, content: "ACP test" },
                              ),
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                { choices: [{ finish_reason: "tool_calls" }] },
              ]
            : [
                { choices: [{ delta: { content: "Done." } }] },
                { choices: [{ finish_reason: "stop" }] },
              ];
          return new Response(
            `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    await writeFile(
      join(configDir, "config.yaml"),
      `providers:\n  test:\n    type: lmstudio\n    base_url: http://127.0.0.1:${server.port}\ndefault_provider: test\ndefault_model: test-model\nsandbox:\n  backend: none\npermissions_disabled: ${scenario === "config-only"}\n`,
    );
    if (scenario === "deny") {
      await mkdir(join(project, ".cleetus"));
      await writeFile(
        join(project, ".cleetus/permissions.yaml"),
        "rules:\n  - tool: write_file\n    decision: deny\n",
      );
      await approveProjectConfiguration({
        projectDir: project,
        globalPath: join(configDir, "config.yaml"),
      });
    }
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../src/bin/cleetus.ts"),
        "acp",
        "--config-dir",
        configDir,
        ...(enabled ? ["--fuckit"] : []),
      ],
      { cwd: project, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const stderr = new Response(child.stderr).text();
    let prompts = 0;
    const client = new AcpTransport({
      write: (line) => {
        child.stdin.write(line);
        void child.stdin.flush();
      },
      requestTimeoutMs: 10_000,
    });
    client.onRequest("session/request_permission", async () => {
      prompts++;
      return { outcome: { outcome: "selected", optionId: "reject_once" } };
    });
    const pump = pumpStdin(client, child.stdout as unknown as AsyncIterable<Uint8Array>);
    try {
      await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const session = (await client.request("session/new", { cwd: project })) as {
        sessionId: string;
      };
      if (scenario === "plan") {
        await client.request("session/set_mode", { sessionId: session.sessionId, modeId: "plan" });
      }
      const prompt = () =>
        client.request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Write the requested test file." }],
        });
      expect(await prompt()).toMatchObject({ stopReason: "end_turn" });
      expect(toolCalls).toBe(1);
      expect(prompts).toBe(enabled ? 0 : 1);
      if (scenario === "fuckit" || scenario === "bash") {
        expect(await readFile(target, "utf8")).toBe("ACP test");
        // The launch opt-in also applies after session/load and on the next turn.
        await client.request("session/load", { sessionId: session.sessionId, cwd: project });
        expect(await prompt()).toMatchObject({ stopReason: "end_turn" });
        expect(toolCalls).toBe(2);
        expect(prompts).toBe(0);
      } else {
        expect(await Bun.file(target).exists()).toBe(false);
      }
      child.stdin.end();
      expect(await child.exited).toBe(0);
      expect((await stderr).includes("permission prompts disabled (--fuckit)")).toBe(enabled);
    } finally {
      child.kill();
      await child.exited;
      await pump;
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}
