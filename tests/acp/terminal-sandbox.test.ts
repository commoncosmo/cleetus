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
