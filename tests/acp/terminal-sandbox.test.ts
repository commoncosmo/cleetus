import { describe, expect, it } from "bun:test";
import { AcpSandbox } from "../../src/acp/terminal-sandbox";
import type { Sandbox } from "../../src/sandbox/types";

const noopFallback: Sandbox = {
  exec: async () => {
    throw new Error("fallback should not exec");
  },
  dispose: async () => {},
  writeRoot: () => null,
};

describe("AcpSandbox", () => {
  it("uses the explicit PowerShell for commands and the stdin bridge", async () => {
    const path = "C:\\Tools\\PowerShell 7\\pwsh.exe";
    const commands: string[] = [];
    const sandbox = new AcpSandbox(
      async (method, raw) => {
        if (method === "terminal/create") {
          commands.push((raw as { command: string }).command);
          return { terminalId: "one" };
        }
        if (method === "terminal/output") return { output: "", exitStatus: { exitCode: 0 } };
        return { exitCode: 0 };
      },
      "s",
      noopFallback,
      "win32",
      process.cwd(),
      path,
    );
    const opts = { signal: new AbortController().signal };
    await sandbox.exec("Write-Output ok", opts);
    await sandbox.execArgv(["bun.exe", "run", "-"], { ...opts, stdin: "console.log('ok')" });
    expect(commands).toEqual([path, path]);
    expect(await sandbox.shellExecutable()).toBe(path);
    await sandbox.dispose();
  });
  it("does not create a terminal for a pre-cancelled command", async () => {
    let calls = 0;
    const abort = new AbortController();
    abort.abort();
    const sandbox = new AcpSandbox(
      async () => {
        calls++;
        return {};
      },
      "s",
      noopFallback,
    );
    expect((await sandbox.exec("echo nope", { signal: abort.signal })).cancelled).toBe(true);
    expect(calls).toBe(0);
  });
  it("forwards direct argv, environment and absolute cwd without shell interpolation", async () => {
    let created: Record<string, unknown> = {};
    const sandbox = new AcpSandbox(
      async (method, params) => {
        if (method === "terminal/create") {
          created = params as Record<string, unknown>;
          return { terminalId: "one" };
        }
        if (method === "terminal/output") return { output: "ok", exitStatus: { exitCode: 0 } };
        return { exitCode: 0 };
      },
      "s",
      noopFallback,
      "win32",
    );
    await sandbox.execArgv(["git.exe", "show", "a path; $literal"], {
      signal: new AbortController().signal,
      cwd: process.cwd(),
      env: { CT_TEST: "a b" },
    });
    expect(created.command).toBe("git.exe");
    expect(created.args).toEqual(["show", "a path; $literal"]);
    expect(created.cwd).toBe(process.cwd());
    expect(created.env).toEqual([{ name: "CT_TEST", value: "a b" }]);
  });
  it("enforces timeout and kills before output/release, with no local fallback", async () => {
    const seen: string[] = [];
    const sandbox = new AcpSandbox(
      async (method) => {
        seen.push(method);
        if (method === "terminal/create") return { terminalId: "one" };
        if (method === "terminal/wait_for_exit") return new Promise(() => {});
        if (method === "terminal/output") return { output: "partial", exitStatus: null };
        return {};
      },
      "s",
      noopFallback,
    );
    const result = await sandbox.exec("wait", {
      signal: new AbortController().signal,
      timeoutMs: 15,
    });
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.stdout).toBe("partial");
    expect(seen.slice(-3)).toEqual(["terminal/kill", "terminal/output", "terminal/release"]);
  });
  it("cancellation during terminal creation returns promptly and cleans up a late terminal", async () => {
    let finish!: (value: unknown) => void;
    const seen: string[] = [];
    const abort = new AbortController();
    const sandbox = new AcpSandbox(
      async (method) => {
        seen.push(method);
        if (method === "terminal/create")
          return new Promise((resolve) => {
            finish = resolve;
          });
        return {};
      },
      "s",
      noopFallback,
    );
    const running = sandbox.exec("wait", { signal: abort.signal });
    abort.abort();
    expect((await running).cancelled).toBe(true);
    finish({ terminalId: "late" });
    await Bun.sleep(10);
    expect(seen).toEqual(["terminal/create", "terminal/kill", "terminal/release"]);
  });
  it("releases on client errors and never executes a local command", async () => {
    const seen: string[] = [];
    const sandbox = new AcpSandbox(
      async (method) => {
        seen.push(method);
        if (method === "terminal/create") return { terminalId: "one" };
        if (method === "terminal/wait_for_exit") throw Error("client broke");
        return {};
      },
      "s",
      noopFallback,
    );
    await expect(sandbox.exec("wait", { signal: new AbortController().signal })).rejects.toThrow(
      "client broke",
    );
    expect(seen.slice(-2)).toEqual(["terminal/kill", "terminal/release"]);
  });
  it("dispose stops active terminals without disposing the shared local sandbox", async () => {
    const seen: string[] = [];
    let fallbackDisposed = false;
    const sandbox = new AcpSandbox(
      async (method) => {
        seen.push(method);
        if (method === "terminal/create") return { terminalId: "one" };
        if (method === "terminal/wait_for_exit") return new Promise(() => {});
        if (method === "terminal/output") return { output: "", exitStatus: null };
        return {};
      },
      "s",
      {
        ...noopFallback,
        dispose: async () => {
          fallbackDisposed = true;
        },
      },
    );
    const running = sandbox.exec("wait", { signal: new AbortController().signal });
    await Bun.sleep(0);
    await sandbox.dispose();
    expect((await running).cancelled).toBe(true);
    expect(seen).toContain("terminal/release");
    expect(fallbackDisposed).toBe(false);
  });
  it("runs a command through the client terminal lifecycle and returns its output + exit code", async () => {
    const seen: string[] = [];
    const request = async (method: string, _params: unknown) => {
      seen.push(method);
      if (method === "terminal/create") return { terminalId: "term1" };
      if (method === "terminal/wait_for_exit") return { exitStatus: { exitCode: 0 } };
      if (method === "terminal/output")
        return { output: "hello\n", truncated: false, exitStatus: { exitCode: 0 } };
      return null;
    };
    const sb = new AcpSandbox(request, "s1", noopFallback);
    const r = await sb.exec("echo hello", { signal: new AbortController().signal });
    expect(r.stdout).toBe("hello\n");
    expect(r.exitCode).toBe(0);
    expect(r.cancelled).toBe(false);
    expect(seen).toEqual([
      "terminal/create",
      "terminal/wait_for_exit",
      "terminal/output",
      "terminal/release",
    ]);
  });

  it("kills the terminal and reports cancelled when the signal aborts", async () => {
    const ac = new AbortController();
    const seen: string[] = [];
    const request = async (method: string, _params: unknown) => {
      seen.push(method);
      if (method === "terminal/create") return { terminalId: "term1" };
      if (method === "terminal/wait_for_exit") {
        ac.abort();
        return await new Promise(() => {}); // never resolves; abort path must win
      }
      if (method === "terminal/output")
        return { output: "partial", truncated: false, exitStatus: null };
      return null;
    };
    const sb = new AcpSandbox(request, "s1", noopFallback);
    const r = await sb.exec("sleep 10", { signal: ac.signal });
    expect(r.cancelled).toBe(true);
    expect(seen).toContain("terminal/kill");
    expect(seen).toContain("terminal/release");
    expect(seen.indexOf("terminal/kill")).toBeLessThan(seen.indexOf("terminal/release"));
  });
});
