import { CONTROL_PROBE_SCRIPT } from "./control-probe";

/** Render launches are direct commands, not PowerShell programs. Preserve quoted
 * arguments as literals rather than evaluating substitutions in a second shell. */
export function windowsRenderArgv(command: string): string[] {
  const args: string[] = [];
  let value = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) {
        if (command[i + 1] === quote) {
          value += c;
          i++;
        } else quote = "";
      } else value += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        args.push(value);
        value = "";
        started = false;
      }
    } else {
      value += c;
      started = true;
    }
  }
  if (quote) throw new Error("launchCommand has an unterminated quoted argument");
  if (started) args.push(value);
  if (!args.length || !/^(?:bun|bunx|npm|npx|pnpm|yarn)$/i.test(args[0]!))
    throw new Error("launchCommand requires a supported package manager");
  return args;
}

/** PowerShell 5.1 is used only for .cmd/.bat shims, with literal argv. No agent
 * command or PowerShell 7 wrapper is evaluated by this internal launcher. */
export function windowsShimScript(argv: string[]): string {
  const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return `$ErrorActionPreference='Stop'; try { & ${argv.map(literal).join(" ")}; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_); exit 1 }`;
}

/** The server and CDP browser must share one MXC execution/container and its lifetime.
 * The outer executor's Job Object reaps all descendants on timeout/cancellation. */
export function windowsRenderScript(input: {
  launchCommand: string;
  url: string;
  expectedText?: string;
  expectedControl?: string;
  expectedAfterText?: string;
  budgetMs: number;
}): string {
  return `
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const input = ${JSON.stringify(input)};
const launch = ${JSON.stringify(windowsRenderArgv(input.launchCommand))};
const shimScript = ${windowsShimScript.toString()};
const override = process.env.CLEETUS_BROWSER;
const candidates = override ? [override] : [
  ...['msedge.exe', 'chrome.exe', 'chromium.exe'].map(name => Bun.which(name)),
  ...[process.env.PROGRAMFILES, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap(root => [join(root,'Microsoft','Edge','Application','msedge.exe'),join(root,'Google','Chrome','Application','chrome.exe')])
];
const browser = candidates.filter(Boolean).map(path => Bun.which(path) || path).find(path => existsSync(path));
if (!browser) { console.error('CLEETUS_BROWSER_UNAVAILABLE: Install Microsoft Edge or Chrome, or set CLEETUS_BROWSER to its executable.'); process.exit(69); }
let server;
try {
  const executable = Bun.which(launch[0]);
  if (!executable) throw new Error('Package manager not found: ' + launch[0]);
  let argv = [executable,...launch.slice(1)];
  if (/\\.(?:cmd|bat)$/i.test(executable)) {
    const root = process.env.SystemRoot || process.env.SYSTEMROOT;
    if (!root) throw new Error('SystemRoot is missing; cannot locate the Windows command-shim launcher');
    const shell = join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const encoded = Buffer.from(shimScript(argv),'utf16le').toString('base64');
    argv = [shell,'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded];
  }
  server = Bun.spawn(argv, {stdout:'pipe',stderr:'pipe'});
}
catch (error) { console.error('CLEETUS_RENDER_BACKEND_ERROR: Cannot launch the development command: ' + (error.code || error.message)); process.exit(69); }
let serverExited = false;
server.exited.then(() => { serverExited = true; });
let serverOutput = '';
for (const stream of [server.stdout, server.stderr]) {
  (async () => { for await (const chunk of stream) serverOutput = (serverOutput + new TextDecoder().decode(chunk)).slice(-8000); })().catch(() => {});
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastOut = '', lastErr = '';
try {
  const deadline = Date.now() + input.budgetMs;
  await sleep(750);
  while (Date.now() < deadline && !serverExited) {
    try {
      const response = await fetch(input.url, {signal: AbortSignal.timeout(1000)});
      await response.body?.cancel();
      if (!response.ok) { await sleep(250); continue; }
    } catch { await sleep(250); continue; }
    const probe = Bun.spawn([process.execPath,'run','-',browser,input.url,input.expectedText || '',input.expectedControl || '',input.expectedAfterText || ''], {
      stdin: new Blob([${JSON.stringify(CONTROL_PROBE_SCRIPT)}]), stdout:'pipe',stderr:'pipe'
    });
    const [out, err, code] = await Promise.all([new Response(probe.stdout).text(),new Response(probe.stderr).text(),probe.exited]);
    lastOut = out; lastErr = err;
    if (/ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/.test(out)) { await sleep(250); continue; }
    const line = out.split(/\\r?\\n/).find(line => line.startsWith('CLEETUS_CONTROL_PROBE:'));
    if (line) {
      const result = JSON.parse(line.slice('CLEETUS_CONTROL_PROBE:'.length));
      if (result.bodyText?.trim()) { console.error(err); process.exitCode = code; break; }
    } else if (code !== 0) { console.error('CLEETUS_RENDER_BACKEND_ERROR: ' + err); process.exitCode = 69; break; }
    await sleep(250);
  }
  if (serverExited) { console.error('CLEETUS_RENDER_SERVER_EXIT: ' + serverOutput); process.exitCode = 1; }
  else if (!lastOut.includes('CLEETUS_CONTROL_PROBE:') || !lastOut.trim()) { console.error(lastErr || 'CLEETUS_RENDER_NOT_READY'); process.exitCode ||= 69; }
  else if (!process.exitCode) { console.log(lastOut); }
} finally {
  // Client-terminal mode has no local MXC Job Object. Reap the server tree while
  // its leader is still alive, before closing inherited pipes and exiting.
  try {
    const stop = Bun.spawn(['taskkill.exe','/PID',String(server.pid),'/T','/F'], {stdout:'ignore',stderr:'ignore'});
    await Promise.race([stop.exited,sleep(2000)]);
    try { stop.kill(); } catch {}
  } catch {}
  try { server.kill(); } catch {}
  console.error(serverOutput);
  console.error('Render server stopped; this tool does not leave a background server running.');
  // MXC destroyOnExit closes the Job Object and reaps descendants. Do not await
  // inherited server pipes: npm grandchildren may still own them until that close.
  process.exit(process.exitCode || 0);
}
`;
}
