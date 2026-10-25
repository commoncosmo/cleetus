import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AcpTransport } from "../src/acp/transport";
import { pumpStdin } from "../src/acp/server";
import { AcpSandbox } from "../src/acp/terminal-sandbox";
import type { Sandbox } from "../src/sandbox/types";
import { RenderCheckTool } from "../src/tools/render-check";

assert.equal(process.platform, "win32");
const binary = resolve(process.argv[2] ?? "dist/acp-smoke/cleetus.exe");
await mkdir("dist/acp-smoke", { recursive: true });
const root = await mkdtemp(join(resolve("dist/acp-smoke"), "spaces Ω "));
const bun = Bun.which("bun.exe")!;
const shell = process.env.CLEETUS_ACP_SMOKE_SHELL ?? Bun.which("pwsh.exe")!;
const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fallback: Sandbox = {
  exec: async () => {
    throw Error("local fallback is forbidden");
  },
  dispose: async () => {},
  writeRoot: () => null,
};

function terminals() {
  const all = new Map<string, { child: ReturnType<typeof Bun.spawn>; output: Promise<string> }>();
  let creates = 0,
    releases = 0;
  const request = async (method: string, raw: unknown) => {
    const p = raw as {
      command: string;
      args: string[];
      cwd: string;
      env: { name: string; value: string }[];
      terminalId: string;
    };
    if (method === "terminal/create") {
      const id = String(++creates);
      const child = Bun.spawn([p.command, ...p.args], {
        cwd: p.cwd,
        env: { ...process.env, ...Object.fromEntries((p.env ?? []).map((e) => [e.name, e.value])) },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).then((parts) => parts.join(""));
      all.set(id, { child, output });
      return { terminalId: id };
    }
    const item = all.get(p.terminalId);
    if (!item) throw Error("unknown terminal");
    if (method === "terminal/wait_for_exit") return { exitCode: await item.child.exited };
    if (method === "terminal/kill" || method === "terminal/release") {
      if (item.child.exitCode === null) {
        const kill = Bun.spawn(["taskkill.exe", "/PID", String(item.child.pid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        await kill.exited;
        await item.child.exited;
      }
      if (method === "terminal/release") {
        all.delete(p.terminalId);
        releases++;
      }
      return {};
    }
    if (method === "terminal/output")
      return {
        output: await item.output,
        exitStatus: { exitCode: await item.child.exited },
        truncated: false,
      };
    throw Error(method);
  };
  return { request, summary: () => ({ creates, releases, active: all.size }) };
}

// Real client-terminal execution covers direct argv and exact stdin without shell quoting.
const clientTerms = terminals();
const adapter = new AcpSandbox(clientTerms.request, "adapter", fallback, "win32", root, shell);
const bytes = "stdin Ω\nwith no final newline";
const direct = await adapter.execArgv(
  [
    bun,
    "-e",
    "const t=await Bun.stdin.text(); console.log(JSON.stringify([process.argv.slice(1),t,process.env.ACP_ENV]));",
    "space and ; $literal",
  ],
  {
    stdin: bytes,
    env: { ACP_ENV: "forwarded" },
    cwd: root,
    signal: new AbortController().signal,
    timeoutMs: 10000,
  },
);
assert.equal(direct.exitCode, 0);
assert.deepEqual(JSON.parse(direct.stdout.trim()), [["space and ; $literal"], bytes, "forwarded"]);
// The Windows render tool passes its full embedded probe through the same stdin bridge.
const portProbe = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
const renderPort = portProbe.port;
portProbe.stop(true);
await writeFile(
  join(root, "package.json"),
  JSON.stringify({ scripts: { dev: "bun " + JSON.stringify(join(root, "server.ts")) } }),
);
await writeFile(
  join(root, "server.ts"),
  `Bun.serve({port:${renderPort},fetch(request){return new Response(new URL(request.url).pathname==='/about'?'<h1>ACP destination ready</h1>':'<h1>ACP browser ready</h1><a href="/about">About</a>',{headers:{'content-type':'text/html'}})}});`,
);
const rendered = await new RenderCheckTool(adapter, { timeoutMs: 30000, maxOutputLines: 20 }).run(
  {
    launchCommand: `npm run dev -- --port ${renderPort}`,
    url: `http://localhost:${renderPort}`,
    expectedText: "ACP browser ready",
    expectedControl: "About",
    expectedAfterText: "ACP destination ready",
  },
  { projectDir: root, abortSignal: new AbortController().signal },
);
assert.equal(rendered.ok, true, JSON.stringify(rendered));
await adapter.dispose();
assert.equal(clientTerms.summary().active, 0);
console.log("ACP_CLIENT_ARGV_STDIN_RENDER_PASS");

for (const clientTerminal of [false, true]) {
  const home = join(root, clientTerminal ? "client mode" : "MXC mode");
  const one = join(home, "project one Ω");
  const two = join(home, "project two Ω");
  const config = join(home, "config");
  for (const dir of [one, two, config]) await mkdir(dir, { recursive: true });
  await writeFile(
    join(two, "cancel-worker.ts"),
    `const child=Bun.spawn([${JSON.stringify(bun)},'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'});await Bun.write('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`,
  );
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models"))
        return Response.json({ data: [{ id: "mock", loaded_context_length: 32768 }] });
      if (url.pathname !== "/v1/chat/completions") return new Response("missing", { status: 404 });
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const last = body.messages.at(-1)!;
      let parts: unknown[];
      if (last.role === "user") {
        const marker = last.content.includes("CASE_CANCEL")
          ? "cancel"
          : last.content.includes("CASE_TIMEOUT")
            ? "timeout"
            : "write";
        const command =
          marker === "write"
            ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'marker.txt'),'ACP_PASS'); Write-Output ACP_WRITE_PASS"
            : marker === "timeout"
              ? "Write-Output ACP_WAIT; Start-Sleep -Seconds 60"
              : `& ${q(bun)} ./cancel-worker.ts`;
        parts = [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: crypto.randomUUID(),
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({
                          command,
                          timeoutMs: marker === "timeout" ? 1500 : 30000,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ finish_reason: "tool_calls" }] },
        ];
      } else
        parts = [
          { choices: [{ delta: { content: "Recorded the result." } }] },
          { choices: [{ finish_reason: "stop" }] },
        ];
      return new Response(
        parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await writeFile(
    join(config, "config.yaml"),
    `providers:\n  mock:\n    type: lmstudio\n    base_url: http://127.0.0.1:${server.port}\ndefault_provider: mock\ndefault_model: mock\nsandbox:\n  backend: host\n`,
  );
  const child = Bun.spawn([binary, "acp", "--config-dir", config, "--shell-executable", shell], {
    // Model a GUI editor whose inherited PATH still selects the packaged alias.
    env: {...process.env,PATH:join(process.env.LOCALAPPDATA!,"Microsoft","WindowsApps")+";"+process.env.PATH},
    cwd: one,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const diagnostics = new Response(child.stderr).text();
  const terminal = terminals();
  const updates: unknown[] = [];
  const client = new AcpTransport({
    write: (line) => {
      child.stdin.write(line);
      void child.stdin.flush();
    },
    requestTimeoutMs: 40000,
  });
  client.onRequest("session/update", async (p) => {
    updates.push(p);
    return {};
  });
  client.onRequest("session/request_permission", async () => ({
    outcome: { outcome: "selected", optionId: "allow_once" },
  }));
  for (const method of [
    "terminal/create",
    "terminal/wait_for_exit",
    "terminal/kill",
    "terminal/output",
    "terminal/release",
  ])
    client.onRequest(method, (p) => terminal.request(method, p));
  let protocolError: unknown;
  const validated = (async function* () {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout as AsyncIterable<Uint8Array>) {
      text += decoder.decode(chunk, { stream: true });
      let pos;
      while ((pos = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, pos).trim();
        if (line) JSON.parse(line);
        text = text.slice(pos + 1);
      }
      yield chunk;
    }
    if (text.trim()) JSON.parse(text);
  })();
  const pump = pumpStdin(client, validated).catch((error) => {
    protocolError = error;
    child.kill();
  });
  let passed = false;
  try {
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { terminal: clientTerminal },
    });
    const a = (await client.request("session/new", { cwd: one })) as { sessionId: string };
    const b = (await client.request("session/new", { cwd: two })) as { sessionId: string };
    const prompt = (sessionId: string, text: string) =>
      client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    assert.deepEqual(await prompt(a.sessionId, "Run CASE_WRITE"), { stopReason: "end_turn" });
    assert.equal(await readFile(join(one, "marker.txt"), "utf8"), "ACP_PASS");
    assert.deepEqual(await prompt(b.sessionId, "Run CASE_WRITE"), { stopReason: "end_turn" });
    assert.equal(await readFile(join(two, "marker.txt"), "utf8"), "ACP_PASS");
    await prompt(b.sessionId, "Run CASE_TIMEOUT");
    assert.match(JSON.stringify(updates), /timed out after 1500ms/);
    const cancelled = prompt(b.sessionId, "Run CASE_CANCEL");
    let pids: number[] | undefined;
    for (let i = 0; i < 150; i++) {
      try {
        pids = JSON.parse(await readFile(join(two, "pids.json"), "utf8"));
        break;
      } catch {}
      await pause(100);
    }
    assert.ok(pids, "cancel workload did not start");
    client.notify("session/cancel", { sessionId: b.sessionId });
    assert.deepEqual(await cancelled, { stopReason: "cancelled" });
    for (const pid of pids) {
      let gone = false;
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          gone = true;
          break;
        }
        await pause(100);
      }
      assert.ok(gone, `surviving child ${pid}`);
    }
    child.stdin.end();
    const exit = await Promise.race([child.exited, pause(15000).then(() => -999)]);
    assert.equal(exit, 0, await diagnostics);
    await pump;
    assert.equal(protocolError, undefined);
    assert.equal(terminal.summary().active, 0);
    console.log(`ACP_COMPILED_${clientTerminal ? "CLIENT_TERMINAL" : "MXC"}_PASS`);
    passed = true;
  } finally {
    child.kill();
    await child.exited;
    client.close();
    await pump;
    server.stop(true);
    if (!passed) console.error((await diagnostics).slice(-5000));
  }
}
console.log(`WINDOWS_ACP_PASS ${root}`);
