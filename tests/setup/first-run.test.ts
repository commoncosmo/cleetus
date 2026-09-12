import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ATTACHMENTS } from "../../src/config/attachments";
import { DEFAULT_BUILD_GATE } from "../../src/config/build-gate";
import { DEFAULT_CONTEXT } from "../../src/config/context";
import { loadConfig } from "../../src/config/loader";
import { DEFAULT_LOOP_GUARD } from "../../src/config/loop-guard";
import { DEFAULT_MALFORMED_PATH } from "../../src/config/malformed-path";
import { DEFAULT_ORCHESTRATION } from "../../src/config/orchestration";
import { DEFAULT_PLAN_MODE_GUARD } from "../../src/config/plan-mode";
import { DEFAULT_RESIZE } from "../../src/config/resize";
import { DEFAULT_SMOKE_RUN } from "../../src/config/smoke-run";
import { DEFAULT_STREAM_WATCHDOG } from "../../src/config/stream-watchdog";
import type { CleetusConfig } from "../../src/config/types";
import { DEFAULT_VISION } from "../../src/config/vision";
import { firstRunSetup } from "../../src/setup/first-run";

function minimalConfig(): CleetusConfig {
  return {
    providers: {},
    mcpServers: {},
    maxToolLoops: 50,
    defaultPersona: "coding",
    defaultPersonality: "neutral",
    personalityCorrection: false,
    defaultEffort: "medium",
    structuredOutput: "auto",
    capability: "auto",
    routing: {
      defaultMode: "manual",
      smart: {
        escalateAfterFailures: 3,
        deescalateAfterSuccesses: 2,
        broadCodePlanCalls: 5,
        contextWindowPercent: 70,
        escalateOnCodeEdit: "always",
        keywords: [],
      },
    },
    sandbox: { backend: "none", network: true },
    webTools: {
      enabled: true,
      allowLocalhost: false,
      maxBytes: 200000,
      search: { provider: "duckduckgo" },
    },
    repoMap: { enabled: true, tokenBudget: 1500 },
    streaming: { enabled: true, reasoning: true, reasoningLines: 10, proseLines: 12 },
    context: { ...DEFAULT_CONTEXT },
    loopGuard: { ...DEFAULT_LOOP_GUARD },
    planMode: { ...DEFAULT_PLAN_MODE_GUARD },
    streamWatchdog: { ...DEFAULT_STREAM_WATCHDOG },
    vision: { ...DEFAULT_VISION },
    attachments: { ...DEFAULT_ATTACHMENTS },
    resize: { ...DEFAULT_RESIZE },
    malformedPath: { ...DEFAULT_MALFORMED_PATH },
    orchestration: { ...DEFAULT_ORCHESTRATION },
    skills: { enabled: true, autoInvoke: true },
    specs: { dir: "docs/specs" },
    subagents: { enabled: true },
    packageManager: { enforceBun: true },
    hooks: [],
    modelFamily: { enabled: true },
    planOrGo: { enabled: false },
    diagnostics: { enabled: true, timeoutMs: 15000, maxReported: 10 },
    format: { enabled: true },
    test: { enabled: true, timeoutMs: 120000, maxOutputLines: 120 },
    smokeRun: { ...DEFAULT_SMOKE_RUN },
    buildGate: { ...DEFAULT_BUILD_GATE },
    checkpoint: { enabled: true, maxCheckpoints: 20 },
    ui: { theme: "dark", colors: {} },
  };
}

test("detection found → continue with populated config + persisted file", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "cleetus-fr-"));
  const fr = await firstRunSetup(minimalConfig(), globalDir, {
    detect: async () => [{ type: "lmstudio", baseUrl: "http://localhost:1234", models: ["m1"] }],
  });
  expect(fr.action).toBe("continue");
  if (fr.action !== "continue") throw new Error("expected continue");
  expect(fr.config.providers.lmstudio?.baseUrl).toBe("http://localhost:1234");
  expect(fr.config.defaultProvider).toBe("lmstudio");
  expect(fr.config.defaultModel).toBe("m1");
  expect(existsSync(join(globalDir, "config.yaml"))).toBe(true);
  expect(fr.message.toLowerCase()).toContain("lmstudio");
  const reloaded = await loadConfig({
    globalPath: join(globalDir, "config.yaml"),
    projectDir: globalDir,
  });
  expect(reloaded.providers.lmstudio?.baseUrl).toBe("http://localhost:1234");
  expect(reloaded.defaultProvider).toBe("lmstudio");
});

test("no detection → exit with a scaffolded config", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "cleetus-fr2-"));
  const fr = await firstRunSetup(minimalConfig(), globalDir, { detect: async () => [] });
  expect(fr.action).toBe("exit");
  expect(existsSync(join(globalDir, "config.yaml"))).toBe(true);
  expect(fr.message.toLowerCase()).toContain("add a provider");
});

test("detection with a pre-existing config.yaml continues without overwriting it", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "cleetus-fr3-"));
  writeFileSync(join(globalDir, "config.yaml"), "# existing, do not clobber\n");
  const fr = await firstRunSetup(minimalConfig(), globalDir, {
    detect: async () => [{ type: "ollama", baseUrl: "http://localhost:11434", models: ["o1"] }],
  });
  expect(fr.action).toBe("continue");
  if (fr.action !== "continue") throw new Error("expected continue");
  expect(fr.config.providers.ollama?.baseUrl).toBe("http://localhost:11434");
  expect(readFileSync(join(globalDir, "config.yaml"), "utf8")).toBe("# existing, do not clobber\n");
  expect(fr.message.toLowerCase()).toContain("session"); // not "wrote <path>"
});

test("llama.cpp detection persists the dotted type and localhost port", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "cleetus-fr4-"));
  const fr = await firstRunSetup(minimalConfig(), globalDir, {
    detect: async () => [
      { type: "llama.cpp", baseUrl: "http://localhost:8080", models: ["coder"] },
    ],
  });
  expect(fr.action).toBe("continue");
  if (fr.action !== "continue") throw new Error("expected continue");
  expect(fr.config.providers["llama.cpp"]).toEqual({
    type: "llama.cpp",
    baseUrl: "http://localhost:8080",
  });
  const persisted = await loadConfig({
    globalPath: join(globalDir, "config.yaml"),
    projectDir: globalDir,
  });
  expect(persisted.providers["llama.cpp"]?.type).toBe("llama.cpp");
  expect(persisted.defaultProvider).toBe("llama.cpp");
});
