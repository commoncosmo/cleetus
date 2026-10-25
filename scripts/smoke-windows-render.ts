import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WindowsSandbox } from "../src/sandbox/windows";
import { RenderCheckTool } from "../src/tools/render-check";

mkdirSync("dist/render-smoke", { recursive: true });
const project = mkdtempSync(join(resolve("dist/render-smoke"), "project-"));
writeFileSync(join(project, "package.json"), JSON.stringify({ devEngines: { packageManager: { name: "npm" } }, scripts: { dev: "bun server.ts" } }));
const html = `<html><body><style>.flex{display:flex}</style><h1>Windows render smoke</h1><div class="flex">one</div><div class="flex">two</div><div class="flex">three</div><button onclick="this.textContent='Clicked'">Click me</button></body></html>`;
writeFileSync(join(project, "server.ts"), `await Bun.write('server.pid',String(process.pid)); Bun.serve({port:5198,fetch(){return new Response(${JSON.stringify(html)},{headers:{'content-type':'text/html'}})}});`);
const sandbox = new WindowsSandbox(project, true, resolve(`dist/cleetus-windows-${process.arch}/native/wxc-exec.exe`));
try {
  const tool = new RenderCheckTool(sandbox, { timeoutMs: 35_000, maxOutputLines: 30 });
  const result = await tool.run({ launchCommand: "npm run dev", url: "http://localhost:5198", expectedText: "Windows render smoke", expectedControl: "Click me", expectedAfterText: "Clicked", expectStyled: true }, { projectDir: project, abortSignal: new AbortController().signal });
  console.log(JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.equal(result.verificationInteraction, true);
  const assertServerStopped = async () => {
    const pid = Number(readFileSync(join(project, "server.pid"), "utf8"));
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
      await Bun.sleep(100);
    }
    throw new Error(`render server survived teardown: ${pid}`);
  };
  await assertServerStopped();

  const missing = new RenderCheckTool({
    shell: "powershell", exec: sandbox.exec.bind(sandbox), dispose: async () => {}, writeRoot: () => project,
    execArgv: (argv, opts) => sandbox.execArgv(argv, { ...opts, env: { ...opts.env, CLEETUS_BROWSER: join(project, "missing-browser.exe") } }),
  }, {timeoutMs:35_000,maxOutputLines:30});
  const unavailable = await missing.run({launchCommand:"npm run dev",url:"http://localhost:5198",expectedText:"Windows render smoke"},{projectDir:project,abortSignal:new AbortController().signal});
  assert.equal(unavailable.verificationUnavailable,true);
  assert.match(unavailable.errorMessage ?? "", /CLEETUS_BROWSER_UNAVAILABLE/);

  unlinkSync(join(project,"server.pid"));
  const abort = new AbortController();
  const cancelled = tool.run({launchCommand:"npm run dev",url:"http://localhost:5198",expectedText:"Windows render smoke"},{projectDir:project,abortSignal:abort.signal});
  for (let i=0; i<100 && !existsSync(join(project,"server.pid")); i++) await Bun.sleep(100);
  assert.equal(existsSync(join(project,"server.pid")),true);
  abort.abort();
  assert.match((await cancelled).errorMessage ?? "", /cancelled/);
  await assertServerStopped();
  console.log(`WINDOWS_RENDER_PASS ${project}`);
} finally { await sandbox.dispose(); }
