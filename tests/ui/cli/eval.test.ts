import { expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerDeps } from "../../../src/eval/runner";
import type { RunRecord } from "../../../src/eval/types";
import { approveProjectConfiguration } from "../../../src/security/project-trust";
import { runEval } from "../../../src/ui/cli/eval";

const globalConfigPath = join(mkdtempSync(join(tmpdir(), "cleetus-cli-global-")), "config.yaml");

async function project(configYaml?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "cleetus-eval-cli-"));
  if (configYaml) {
    mkdirSync(join(dir, ".cleetus"), { recursive: true });
    writeFileSync(join(dir, ".cleetus", "config.yaml"), configYaml);
  }
  await approveProjectConfiguration({ projectDir: dir, globalPath: globalConfigPath });
  return dir;
}

test("fails closed (exit 3) when sandbox backend is not docker", async () => {
  const dir = await project(); // no config → backend defaults to host (still != docker → refuses)
  let err = "";
  // Point global config at a non-existent path so the user's real global config
  // (which may have backend: docker) doesn't bleed in.
  const code = await runEval(["eval"], dir, {
    write: () => {},
    writeErr: (s) => {
      err += s;
    },
    globalConfigPath,
  });
  expect(code).toBe(3);
  expect(err).toContain("docker");
});

test("with docker configured but no scenarios → friendly note, exit 0", async () => {
  const dir = await project("sandbox:\n  backend: docker\n  image: bash:latest\n");
  let out = "";
  // Point global config at a non-existent path so only the project config applies.
  const code = await runEval(["eval"], dir, {
    write: (s) => {
      out += s;
    },
    writeErr: () => {},
    globalConfigPath,
  });
  expect(code).toBe(0);
  expect(out.toLowerCase()).toContain("no scenarios");
});

test("docker backend with no image → refuses (exit 3)", async () => {
  const dir = await project("sandbox:\n  backend: docker\n");
  let err = "";
  const code = await runEval(["eval"], dir, {
    write: () => {},
    writeErr: (s) => {
      err += s;
    },
    globalConfigPath,
  });
  expect(code).toBe(3);
  expect(err.toLowerCase()).toContain("image");
});

test("max_tool_loops: 0 in config reaches the runner as Infinity, not literal 0", async () => {
  // Regression for the eval/improve bypass: the baseline `RunnerDeps` must be built via
  // resolveMaxToolLoops, not a raw pass-through of config.maxToolLoops (which would make
  // the runtime's `for (i = 0; i < 0; i++)` loop execute zero tool calls instead of unlimited).
  let captured: number | undefined;
  mock.module("../../../src/eval/runner", () => ({
    runCandidate: async (
      _candidate: unknown,
      scenario: { name: string },
      deps: RunnerDeps,
    ): Promise<RunRecord> => {
      captured = deps.baseline.maxToolLoops;
      return {
        candidate: "baseline",
        scenario: scenario.name,
        events: [],
        checkExitCode: 0,
        agentOutcome: "completed",
        elapsedMs: 0,
      };
    },
  }));

  const dir = await project(
    [
      "sandbox:",
      "  backend: docker",
      "  image: bash:latest",
      "max_tool_loops: 0",
      "default_provider: p",
      "default_model: m",
      "providers:",
      "  p:",
      "    type: lmstudio",
      "    base_url: http://localhost:1234",
      "",
    ].join("\n"),
  );
  const scenDir = join(dir, "scenarios", "s1");
  mkdirSync(scenDir, { recursive: true });
  writeFileSync(join(scenDir, "scenario.yaml"), "prompt: hi\ncheck: 'true'\n");

  const code = await runEval(["eval"], dir, {
    write: () => {},
    writeErr: () => {},
    globalConfigPath,
  });
  expect(code).toBe(0);
  expect(captured).toBe(Number.POSITIVE_INFINITY);
});
