import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SmartConfig } from "../../src/config/types";
import { BASELINE, type Candidate } from "../../src/eval/candidate";
import { type RunnerDeps, runCandidate } from "../../src/eval/runner";
import type { Scenario } from "../../src/eval/scenario";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, StreamEvent } from "../../src/providers/types";
import { type ExecResult, type Sandbox, SandboxUnavailableError } from "../../src/sandbox/types";

const SMART: SmartConfig = {
  escalateAfterFailures: 3,
  deescalateAfterSuccesses: 2,
  broadCodePlanCalls: 5,
  contextWindowPercent: 70,
  escalateOnCodeEdit: "always",
  keywords: [],
};

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    name: "s",
    prompt: "make foo",
    check: "CHECKCMD",
    checkTimeoutMs: 1000,
    agentTimeoutMs: 5000,
    fixtureDir: null,
    ...over,
  };
}

function bashThenDoneProvider(): Provider {
  let call = 0;
  return {
    listModels: async () => [],
    embed: async () => [],
    async *chat(): AsyncIterable<StreamEvent> {
      if (call++ === 0) {
        yield { type: "tool-call", call: { id: "c1", name: "bash", args: { command: "echo hi" } } };
        yield { type: "finish", reason: "tool-calls" };
      } else {
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

function makeFake(execFn: (cmd: string) => Partial<ExecResult> = () => ({})) {
  const calls: string[] = [];
  let disposed = false;
  const sandbox: Sandbox = {
    async exec(command: string): Promise<ExecResult> {
      calls.push(command);
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        ...execFn(command),
      };
    },
    async dispose() {
      disposed = true;
    },
    writeRoot: () => null,
  };
  return { sandbox, calls, isDisposed: () => disposed };
}

function deps(provider: Provider, makeSandbox: RunnerDeps["makeSandbox"]): RunnerDeps {
  const providers = new ProviderRegistry();
  providers.register("p", provider);
  return {
    providers,
    sandboxConfig: { backend: "docker", image: "x", network: true },
    makeSandbox,
    baseline: {
      systemPrompt: "sys",
      active: { provider: "p", model: "m" },
      mode: "manual",
      tiers: undefined,
      smart: SMART,
      maxToolLoops: 10,
    },
  };
}

test("completed run + passing check → records completed/0; sandbox used and disposed", async () => {
  const fake = makeFake();
  const rec = await runCandidate(
    BASELINE,
    scenario(),
    deps(bashThenDoneProvider(), () => fake.sandbox),
  );
  expect(rec.agentOutcome).toBe("completed");
  expect(rec.checkExitCode).toBe(0);
  expect(rec.candidate).toBe("baseline");
  expect(fake.calls).toContain("set -o pipefail\necho hi");
  expect(fake.calls).toContain("CHECKCMD");
  expect(fake.isDisposed()).toBe(true);
  expect(rec.events.some((e) => e.type === "assistant_message")).toBe(true);
});

test("failing check is recorded", async () => {
  const fake = makeFake((cmd) => (cmd === "CHECKCMD" ? { exitCode: 1 } : { exitCode: 0 }));
  const rec = await runCandidate(
    BASELINE,
    scenario(),
    deps(bashThenDoneProvider(), () => fake.sandbox),
  );
  expect(rec.checkExitCode).toBe(1);
});

test("SandboxUnavailableError during the check → sandbox_unavailable", async () => {
  const fake = makeFake((cmd) => {
    if (cmd === "CHECKCMD") throw new SandboxUnavailableError("down");
    return {};
  });
  const rec = await runCandidate(
    BASELINE,
    scenario(),
    deps(bashThenDoneProvider(), () => fake.sandbox),
  );
  expect(rec.agentOutcome).toBe("sandbox_unavailable");
  expect(rec.checkExitCode).toBeNull();
});

test("agent timeout → timed_out", async () => {
  const blocking: Provider = {
    listModels: async () => [],
    embed: async () => [],
    async *chat(opts): AsyncIterable<StreamEvent> {
      await new Promise<void>((res) => {
        if (opts.signal?.aborted) return res();
        opts.signal?.addEventListener("abort", () => res(), { once: true });
      });
      yield { type: "finish", reason: "stop" };
    },
  };
  const fake = makeFake();
  const rec = await runCandidate(
    BASELINE,
    scenario({ agentTimeoutMs: 20 }),
    deps(blocking, () => fake.sandbox),
  );
  expect(rec.agentOutcome).toBe("timed_out");
});

test("candidate.tools subsets the tool set (bash excluded → bash never runs)", async () => {
  const fake = makeFake();
  const candidate: Candidate = { name: "no-bash", tools: ["read_file"] };
  const rec = await runCandidate(
    candidate,
    scenario(),
    deps(bashThenDoneProvider(), () => fake.sandbox),
  );
  expect(fake.calls).not.toContain("echo hi");
  expect(fake.calls).toContain("CHECKCMD");
  expect(rec.candidate).toBe("no-bash");
});

function writeFileThenDoneProvider(path: string): Provider {
  let call = 0;
  return {
    listModels: async () => [],
    embed: async () => [],
    async *chat(): AsyncIterable<StreamEvent> {
      if (call++ === 0) {
        yield {
          type: "tool-call",
          call: { id: "w1", name: "write_file", args: { path, content: "x" } },
        };
        yield { type: "finish", reason: "tool-calls" };
      } else {
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

test("a relative write_file lands in the isolated workdir, not the real cwd", async () => {
  const marker = `eval-escape-${process.pid}-${Date.now()}.txt`;
  const fake = makeFake();
  await runCandidate(
    BASELINE,
    scenario(),
    deps(writeFileThenDoneProvider(marker), () => fake.sandbox),
  );
  // The write was anchored to the (now-cleaned) temp workdir, never the real cwd.
  expect(existsSync(join(process.cwd(), marker))).toBe(false);
});

test("an absolute write_file escaping the workdir is denied", async () => {
  const abs = join(tmpdir(), `eval-escape-${process.pid}-${Date.now()}.txt`);
  const fake = makeFake();
  await runCandidate(
    BASELINE,
    scenario(),
    deps(writeFileThenDoneProvider(abs), () => fake.sandbox),
  );
  expect(existsSync(abs)).toBe(false); // permission denied → never written
});
