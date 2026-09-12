import { describe, expect, test } from "bun:test";
import type { SmartConfig } from "../../src/config/types";
import { BASELINE } from "../../src/eval/candidate";
import { type RunnerDeps, runCandidate } from "../../src/eval/runner";
import type { Scenario } from "../../src/eval/scenario";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, StreamEvent } from "../../src/providers/types";
import { createSandbox } from "../../src/sandbox/factory";

async function dockerAvailable(): Promise<boolean> {
  try {
    const p = Bun.spawn(["docker", "version"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

// Opt-in: this drives a real container end-to-end (pulls an image from a registry), which is
// network-flaky on CI. Run it deliberately with `CLEETUS_DOCKER_TESTS=1 bun test`; otherwise
// (including in CI) it skips.
const HAS_DOCKER = !!process.env.CLEETUS_DOCKER_TESTS && (await dockerAvailable());

const SMART: SmartConfig = {
  escalateAfterFailures: 3,
  deescalateAfterSuccesses: 2,
  broadCodePlanCalls: 5,
  contextWindowPercent: 70,
  escalateOnCodeEdit: "always",
  keywords: [],
};

// A scripted "agent": emits one bash tool call that writes the file, then finishes.
function scriptedAgent(): Provider {
  let call = 0;
  return {
    listModels: async () => [],
    embed: async () => [],
    async *chat(): AsyncIterable<StreamEvent> {
      if (call++ === 0) {
        yield {
          type: "tool-call",
          call: { id: "c1", name: "bash", args: { command: "echo -n bar > foo.txt" } },
        };
        yield { type: "finish", reason: "tool-calls" };
      } else {
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

describe.skipIf(!HAS_DOCKER)("runner integration (real Docker)", () => {
  test("drives a real container + check end-to-end with a scripted agent", async () => {
    const providers = new ProviderRegistry();
    providers.register("p", scriptedAgent());
    const deps: RunnerDeps = {
      providers,
      sandboxConfig: { backend: "docker", image: "bash:latest", network: true },
      makeSandbox: createSandbox,
      baseline: {
        systemPrompt: "sys",
        active: { provider: "p", model: "m" },
        mode: "manual",
        tiers: undefined,
        smart: SMART,
        maxToolLoops: 10,
      },
    };
    const scenario: Scenario = {
      name: "hello",
      prompt: "make foo",
      check: 'test "$(cat foo.txt)" = bar',
      checkTimeoutMs: 30_000,
      agentTimeoutMs: 60_000,
      fixtureDir: null,
    };
    const rec = await runCandidate(BASELINE, scenario, deps);
    expect(rec.agentOutcome).toBe("completed");
    expect(rec.checkExitCode).toBe(0);
  }, 120_000);
});
