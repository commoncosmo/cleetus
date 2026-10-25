import { dirname, join } from "node:path";
import { Readable } from "node:stream";
const executable = join(dirname(process.execPath), "native/wxc-exec.exe");
export function probe() {
  const p = Bun.spawnSync([executable, "--probe"]);
  if (p.exitCode) throw new Error(p.stderr.toString());
  return JSON.parse(p.stdout.toString());
}
export const getPlatformSupport = () => ({ transport: "executor", probe: probe() });
export async function spawn(request: any) {
  const config = {
    version: "1.0.0",
    containerId: crypto.randomUUID().replaceAll("-", ""),
    containment: "processcontainer",
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    ui: { disable: false, clipboard: "none", injection: false },
    processContainer: {
      capabilities: [],
      ui: {
        isolation: "container",
        desktopSystemControl: false,
        systemSettings: "none",
        ime: false,
      },
    },
    process: {
      commandLine: request.command,
      cwd: request.workingDirectory,
      timeout: request.timeoutMs,
      inheritDefaultEnv: true,
    },
    filesystem: {
      readwritePaths: request.filesystem.readwritePaths,
      readonlyPaths: request.filesystem.readonlyPaths,
      deniedPaths: request.filesystem.deniedPaths,
    },
    network: request.network,
  };
  const p = Bun.spawn(
    [executable, "--config-base64", Buffer.from(JSON.stringify(config)).toString("base64")],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  return {
    id: p.pid,
    standardOutput: Readable.fromWeb(p.stdout as any),
    standardError: Readable.fromWeb(p.stderr as any),
    kill: () => {
      if (p.exitCode === null) p.kill();
    },
    dispose: () => {},
    wait: async () => ({ exitCode: await p.exited }),
  };
}
export async function run(request: any) {
  const p = await spawn(request);
  let stdout = "",
    stderr = "";
  p.standardOutput.on("data", (b) => {
    stdout += b.toString();
  });
  p.standardError.on("data", (b) => {
    stderr += b.toString();
  });
  const result = await p.wait();
  return { ...result, stdout, stderr };
}
