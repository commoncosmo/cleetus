import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoneSandbox } from "../../src/sandbox/none";
import {
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  SandboxUnavailableError,
} from "../../src/sandbox/types";
import { BashTool } from "../../src/tools/bash";

let dir: string;
const ctx = () => ({ projectDir: dir, abortSignal: new AbortController().signal });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-bash-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

class UnavailableSandbox implements Sandbox {
  async exec(_command: string, _opts: ExecOptions): Promise<ExecResult> {
    throw new SandboxUnavailableError("daemon down");
  }
  async dispose() {}
  writeRoot(): string | null {
    return null;
  }
}

class TimedOutWithSurvivorsSandbox implements Sandbox {
  async exec(_command: string, _opts: ExecOptions): Promise<ExecResult> {
    return {
      stdout: "early",
      stderr: "",
      exitCode: null,
      timedOut: true,
      cancelled: false,
      survivors: [4821],
    };
  }
  async dispose() {}
  writeRoot(): string | null {
    return null;
  }
}

class CancelledWithSurvivorsSandbox implements Sandbox {
  async exec(_command: string, _opts: ExecOptions): Promise<ExecResult> {
    return {
      stdout: "early",
      stderr: "",
      exitCode: null,
      timedOut: false,
      cancelled: true,
      survivors: [4821],
    };
  }
  async dispose() {}
  writeRoot(): string | null {
    return null;
  }
}

class NonzeroSandbox implements Sandbox {
  constructor(private readonly out: { stdout?: string; stderr?: string }) {}
  async exec(_command: string, _opts: ExecOptions): Promise<ExecResult> {
    return {
      stdout: this.out.stdout ?? "",
      stderr: this.out.stderr ?? "",
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      survivors: [],
    };
  }
  async dispose() {}
  writeRoot(): string | null {
    return null;
  }
}

describe("BashTool survivors", () => {
  it("appends a teardown warning when processes survived a timeout", async () => {
    const tool = new BashTool(new TimedOutWithSurvivorsSandbox());
    const r = await tool.run({ command: "bun run dev", timeoutMs: 100 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("⚠ 1 process(es) survived teardown");
    expect(r.errorMessage).toContain("4821");
  });

  it("appends a teardown warning when processes survived a cancellation", async () => {
    const tool = new BashTool(new CancelledWithSurvivorsSandbox());
    const r = await tool.run({ command: "bun run dev", timeoutMs: 100 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("⚠ 1 process(es) survived teardown");
    expect(r.errorMessage).toContain("4821");
  });
});

describe("BashTool", () => {
  it("runs a command and captures stdout", async () => {
    const tool = new BashTool(new NoneSandbox(dir));
    const r = await tool.run({ command: "echo hello" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("hello");
  });

  it("captures non-zero exit as non-ok", async () => {
    const tool = new BashTool(new NoneSandbox(dir));
    const r = await tool.run({ command: "exit 3" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("exit");
  });

  it("preserves an upstream pipeline failure when output is trimmed", async () => {
    const tool = new BashTool(new NoneSandbox(dir));
    const r = await tool.run({ command: "bash -c 'exit 7' | tail -1" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("exit 7");
  });

  it("times out long commands", async () => {
    const tool = new BashTool(new NoneSandbox(dir));
    const r = await tool.run({ command: "sleep 10", timeoutMs: 200 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/timed out|timeout/i);
  });

  it("returns a sandbox-unavailable error when the sandbox cannot run (fail-closed)", async () => {
    const tool = new BashTool(new UnavailableSandbox());
    const r = await tool.run({ command: "echo hi" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("sandbox unavailable");
  });
});

// A mock sandbox whose writeRoot and exec result are configurable, and that records whether
// exec was called (to prove the cwd pre-flight short-circuits before running anything).
class BoundarySandbox implements Sandbox {
  execCalled = false;
  lastOptions?: ExecOptions;
  constructor(
    private readonly root: string | null,
    private readonly result: ExecResult,
  ) {}
  async exec(_command: string, opts: ExecOptions): Promise<ExecResult> {
    this.execCalled = true;
    this.lastOptions = opts;
    return this.result;
  }
  async dispose() {}
  writeRoot(): string | null {
    return this.root;
  }
}

const okResult = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
  cancelled: false,
});

const failResult = (stderr: string): ExecResult => ({
  stdout: "",
  stderr,
  exitCode: 1,
  timedOut: false,
  cancelled: false,
});

describe("BashTool project boundary", () => {
  it("blocks a destructive command before exec even when Bash itself was already authorized", async () => {
    await Bun.write(join(dir, "package.json"), "{}");
    const sb = new BoundarySandbox(dir, okResult("unused"));
    const res = await new BashTool(sb).run({ command: "rm -rf ./*" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("PERMISSION_DENIED");
    expect(res.errorMessage).toContain("cannot be bypassed by a saved Bash permission");
    expect(sb.execCalled).toBe(false);
  });

  it("blocks npx/npm in a Bun project (bun.lock present) before exec, suggesting the Bun equivalent", async () => {
    await Bun.write(join(dir, "bun.lock"), "");
    const sb = new BoundarySandbox(dir, okResult("unused"));
    const res = await new BashTool(sb).run({ command: "npx vitest run" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("PERMISSION_DENIED");
    expect(res.errorMessage).toContain("bunx vitest run");
    expect(sb.execCalled).toBe(false);
  });

  it("does not block a foreign package manager when the project is not bun-managed", async () => {
    await Bun.write(join(dir, "package.json"), "{}"); // no bun lockfile
    const sb = new BoundarySandbox(dir, okResult("ran"));
    const res = await new BashTool(sb).run({ command: "npx vitest run" }, ctx());
    expect(res.ok).toBe(true);
    expect(sb.execCalled).toBe(true);
  });

  it("allows Bun's own commands in a Bun project", async () => {
    await Bun.write(join(dir, "bun.lock"), "");
    const sb = new BoundarySandbox(dir, okResult("added"));
    const res = await new BashTool(sb).run({ command: "bun add react" }, ctx());
    expect(res.ok).toBe(true);
    expect(sb.execCalled).toBe(true);
  });

  it("honors the escape hatch: enforcePackageManager=false allows npx in a Bun project", async () => {
    await Bun.write(join(dir, "bun.lock"), "");
    const sb = new BoundarySandbox(dir, okResult("ran"));
    const res = await new BashTool(sb, { enforcePackageManager: false }).run(
      { command: "npx vitest run" },
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect(sb.execCalled).toBe(true);
  });

  it("marks ordinary Bash executions so the host sandbox protects .git and .cleetus", async () => {
    const sb = new BoundarySandbox(dir, okResult("ok"));
    const res = await new BashTool(sb).run({ command: "bun test" }, ctx());
    expect(res.ok).toBe(true);
    expect(sb.lastOptions?.protectProjectMetadata).toBe(true);
  });

  it("denies an out-of-tree cwd before executing", async () => {
    const sb = new BoundarySandbox(dir, okResult("unused"));
    const tool = new BashTool(sb);
    const res = await tool.run({ command: "ls", cwd: "/etc" }, ctx());
    expect(res.ok).toBe(false);
    expect(sb.execCalled).toBe(false);
    expect(res.errorMessage).toContain("bash cwd is outside the project sandbox");
    expect(res.errorMessage).toContain(dir);
  });

  it("allows an in-tree cwd (exec runs)", async () => {
    const sb = new BoundarySandbox(dir, okResult("ok"));
    const tool = new BashTool(sb);
    const res = await tool.run({ command: "ls", cwd: dir }, ctx());
    expect(res.ok).toBe(true);
    expect(sb.execCalled).toBe(true);
  });

  it("allows cwd:'.' (relative project root) — not falsely denied", async () => {
    const sb = new BoundarySandbox(dir, okResult("ok"));
    const tool = new BashTool(sb);
    const res = await tool.run({ command: "ls", cwd: "." }, ctx());
    expect(sb.execCalled).toBe(true);
    expect(res.ok).toBe(true);
  });

  it("allows cwd set to the confining root dir itself — not falsely denied", async () => {
    // Redundant with "allows an in-tree cwd" for the absolute-root case but explicit.
    const sb = new BoundarySandbox(dir, okResult("ok"));
    const tool = new BashTool(sb);
    const res = await tool.run({ command: "echo hi", cwd: dir }, ctx());
    expect(sb.execCalled).toBe(true);
    expect(res.ok).toBe(true);
  });

  it("appends a boundary advisory when a write is denied under a confining sandbox", async () => {
    const sb = new BoundarySandbox(dir, failResult("mkdir: /elsewhere: Operation not permitted"));
    const tool = new BashTool(sb);
    const res = await tool.run({ command: "mkdir -p /elsewhere" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toContain("Operation not permitted"); // original output preserved
    expect(res.errorMessage).toContain(`Writes are confined to ${dir}`);
  });

  it("appends a Go-cache redirect hint when `go test` is denied writing its build cache", async () => {
    const sb = new BoundarySandbox(
      dir,
      failResult(
        "open /Users/example/Library/Caches/go-build/d3/abc-d: operation not permitted\nFAIL",
      ),
    );
    const res = await new BashTool(sb).run({ command: "go test ./..." }, ctx());
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("OUT_OF_TREE");
    expect(res.errorMessage).toContain("GOCACHE"); // the actionable, Go-specific remediation
    expect(res.errorMessage).toContain(`Writes are confined to ${dir}`); // generic advisory still there
  });

  it("does not append an advisory when the sandbox does not confine writes", async () => {
    const sb = new BoundarySandbox(null, failResult("mkdir: /elsewhere: Operation not permitted"));
    const tool = new BashTool(sb);
    const res = await tool.run({ command: "mkdir -p /elsewhere" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.errorMessage).not.toContain("Writes are confined to");
  });

  it("does not append an advisory on an ordinary non-write failure", async () => {
    const sb = new BoundarySandbox(dir, failResult("bash: nope: command not found"));
    const tool = new BashTool(sb);
    const res = await tool.run({ command: "nope" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.errorMessage).not.toContain("Writes are confined to");
  });
});

describe("BashTool BSD/GNU hint", () => {
  it("appends a targeted hint when a GNU-only flag fails on BSD", async () => {
    const tool = new BashTool(new NonzeroSandbox({ stderr: "cat: illegal option -- A" }));
    const r = await tool.run({ command: "cat -A tsconfig.json" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("cat -v"); // the fix
    expect(r.errorMessage).toContain("illegal option"); // original output preserved
  });

  it("does not append a hint on an ordinary (non-option) failure", async () => {
    const tool = new BashTool(
      new NonzeroSandbox({ stderr: "cat: missing.txt: No such file or directory" }),
    );
    const r = await tool.run({ command: "cat missing.txt" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).not.toContain("BSD coreutils");
    expect(r.errorMessage).not.toContain("GNU-only");
  });
});

describe("BashTool output truncation", () => {
  it("oversized output keeps the tail where errors live", async () => {
    // ~300KB of filler with the actionable error on the FINAL line — the old head-only
    // truncation dropped it.
    const tool = new BashTool(new NoneSandbox(dir));
    const command = `head -c 300000 /dev/zero | tr '\\0' x; echo; echo 'ERROR: the real failure'`;
    const result = await tool.run({ command }, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("ERROR: the real failure");
    expect(result.output).toContain("bytes elided");
    expect(result.output!.startsWith("xxx")).toBe(true); // head is also preserved
  });
});
