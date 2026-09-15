import { expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImproveRoundDeps } from "../../../src/improve/round";
import { approveProjectConfiguration } from "../../../src/security/project-trust";
import { runImprove } from "../../../src/ui/cli/improve";

const globalConfigPath = join(mkdtempSync(join(tmpdir(), "cleetus-cli-global-")), "config.yaml");

async function project(configYaml?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "cleetus-improve-cli-"));
  if (configYaml) {
    mkdirSync(join(dir, ".cleetus"), { recursive: true });
    writeFileSync(join(dir, ".cleetus", "config.yaml"), configYaml);
  }
  await approveProjectConfiguration({ projectDir: dir, globalPath: globalConfigPath });
  return dir;
}

test("fails closed (exit 3) when sandbox backend is not docker", async () => {
  const dir = await project();
  let err = "";
  const code = await runImprove(["improve"], dir, {
    write: () => {},
    writeErr: (s) => {
      err += s;
    },
    globalConfigPath,
  });
  expect(code).toBe(3);
  expect(err).toContain("docker");
});

test("docker backend with no image → refuses (exit 3)", async () => {
  const dir = await project("sandbox:\n  backend: docker\n");
  let err = "";
  const code = await runImprove(["improve"], dir, {
    write: () => {},
    writeErr: (s) => {
      err += s;
    },
    globalConfigPath,
  });
  expect(code).toBe(3);
  expect(err.toLowerCase()).toContain("image");
});

test("docker configured but no scenarios → friendly note, exit 0", async () => {
  const dir = await project("sandbox:\n  backend: docker\n  image: bash:latest\n");
  let out = "";
  const code = await runImprove(["improve"], dir, {
    write: (s) => {
      out += s;
    },
    writeErr: () => {},
    globalConfigPath,
  });
  expect(code).toBe(0);
  expect(out.toLowerCase()).toContain("no scenarios");
});

test("max_tool_loops: 0 in config reaches runImproveRound's baseline as Infinity, not literal 0", async () => {
  // Regression for the eval/improve bypass: the baseline RunnerDeps handed to
  // runImproveRound must be built via resolveMaxToolLoops, not a raw pass-through of
  // config.maxToolLoops (which would make the runtime's tool-loop `for` loop run zero
  // iterations instead of unlimited).
  let captured: number | undefined;
  mock.module("../../../src/improve/round", () => ({
    runImproveRound: async (deps: ImproveRoundDeps) => {
      captured = deps.runnerDeps.baseline.maxToolLoops;
      return {
        comparison: { baseline: "baseline", ranked: [] },
        winner: null,
        applied: false,
        note: "stubbed for test",
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

  const code = await runImprove(["improve"], dir, {
    write: () => {},
    writeErr: () => {},
    globalConfigPath,
  });
  expect(code).toBe(0);
  expect(captured).toBe(Number.POSITIVE_INFINITY);
});
