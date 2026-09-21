import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SMART_CONFIG, resolveRouting } from "../../src/config/routing";
import { resolveSandbox } from "../../src/config/sandbox";
import { loadConfig } from "../helpers/trusted-config";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-cfg-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads providers and defaults from a yaml file", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(
      path,
      "providers:\n  lm:\n    type: lmstudio\n    base_url: http://localhost:1234\ndefault_provider: lm\n",
    );
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.providers.lm!.type).toBe("lmstudio");
    expect(cfg.providers.lm!.baseUrl).toBe("http://localhost:1234");
    expect(cfg.defaultProvider).toBe("lm");
  });

  it("loads a llama.cpp provider without requiring /v1 in its base URL", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(
      path,
      "providers:\n  remote:\n    type: llama.cpp\n    base_url: http://example.test:8080\ndefault_provider: remote\n",
    );
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.providers.remote).toEqual({
      type: "llama.cpp",
      baseUrl: "http://example.test:8080",
      apiKey: undefined,
    });
  });

  it("merges project config over global (project wins)", async () => {
    const global = join(dir, "global.yaml");
    await writeFile(
      global,
      "providers:\n  lm:\n    type: lmstudio\n    base_url: http://localhost:1234\ndefault_provider: lm\n",
    );
    const projectDir = join(dir, "proj");
    await mkdir(join(projectDir, ".cleetus"), { recursive: true });
    await writeFile(join(projectDir, ".cleetus", "config.yaml"), "default_model: my-model\n");
    const cfg = await loadConfig({ globalPath: global, projectDir });
    expect(cfg.defaultProvider).toBe("lm");
    expect(cfg.defaultModel).toBe("my-model");
  });

  it("interpolates ${ENV_VAR} from process.env", async () => {
    process.env.CLEETUS_TEST_KEY = "secret-123";
    const path = join(dir, "config.yaml");
    await writeFile(
      path,
      "providers:\n  lm:\n    type: lmstudio\n    base_url: http://h:1234\n    api_key: ${CLEETUS_TEST_KEY}\ndefault_provider: lm\n",
    );
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.providers.lm!.apiKey).toBe("secret-123");
    // biome-ignore lint/performance/noDelete: delete is the correct idiom for env cleanup; assigning undefined would coerce to the string "undefined"
    delete process.env.CLEETUS_TEST_KEY;
  });

  it("throws CleetusError on invalid yaml", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(path, "providers:\n  - not_a_map\n");
    await expect(loadConfig({ globalPath: path, projectDir: dir })).rejects.toThrow(
      /CONFIG_INVALID/,
    );
  });

  it("returns empty config when no files exist", async () => {
    const cfg = await loadConfig({ globalPath: join(dir, "missing.yaml"), projectDir: dir });
    expect(cfg.providers).toEqual({});
    expect(cfg.defaultProvider).toBeUndefined();
  });

  it("parses mcp_servers with defaults applied", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(
      path,
      [
        "mcp_servers:",
        "  github:",
        "    command: npx",
        "    args: ['-y', '@modelcontextprotocol/server-github']",
        "  minimal:",
        "    command: my-server",
      ].join("\n"),
    );
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.mcpServers.github!.command).toBe("npx");
    expect(cfg.mcpServers.github!.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
    expect(cfg.mcpServers.github!.enabled).toBe(true);
    expect(cfg.mcpServers.minimal!.args).toEqual([]);
    expect(cfg.mcpServers.minimal!.env).toEqual({});
    expect(cfg.mcpServers.minimal!.enabled).toBe(true);
  });

  it("defaults mcpServers to an empty object when absent", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(path, "providers: {}\n");
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.mcpServers).toEqual({});
  });

  it("defaults maxToolLoops to the unlimited sentinel when absent", async () => {
    const cfg = await loadConfig({ globalPath: join(dir, "missing.yaml"), projectDir: dir });
    expect(cfg.maxToolLoops).toBe(0);
  });

  it("parses max_tool_loops from yaml", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(path, "max_tool_loops: 30\n");
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.maxToolLoops).toBe(30);
  });

  it("lets project max_tool_loops override global", async () => {
    const global = join(dir, "global.yaml");
    await writeFile(global, "max_tool_loops: 20\n");
    const projectDir = join(dir, "proj");
    await mkdir(join(projectDir, ".cleetus"), { recursive: true });
    await writeFile(join(projectDir, ".cleetus", "config.yaml"), "max_tool_loops: 80\n");
    const cfg = await loadConfig({ globalPath: global, projectDir });
    expect(cfg.maxToolLoops).toBe(80);
  });

  it("rejects a negative max_tool_loops at the schema layer", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(path, "max_tool_loops: -1\n");
    await expect(loadConfig({ globalPath: path, projectDir: dir })).rejects.toThrow(
      /CONFIG_INVALID/,
    );
  });

  it("accepts max_tool_loops: 0 (unlimited sentinel) at the schema layer", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(path, "max_tool_loops: 0\n");
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.maxToolLoops).toBe(0);
  });

  it("defaults persona to coding when absent", async () => {
    const cfg = await loadConfig({ globalPath: join(dir, "missing.yaml"), projectDir: dir });
    expect(cfg.defaultPersona).toBe("coding");
  });

  it("parses default_persona from yaml", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(path, "default_persona: chat\n");
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.defaultPersona).toBe("chat");
  });

  it("parses security as the default_persona", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(path, "default_persona: security\n");
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.defaultPersona).toBe("security");
  });

  it("lets project default_persona override global", async () => {
    const global = join(dir, "global.yaml");
    await writeFile(global, "default_persona: chat\n");
    const projectDir = join(dir, "proj");
    await mkdir(join(projectDir, ".cleetus"), { recursive: true });
    await writeFile(join(projectDir, ".cleetus", "config.yaml"), "default_persona: concise\n");
    const cfg = await loadConfig({ globalPath: global, projectDir });
    expect(cfg.defaultPersona).toBe("concise");
  });

  it("rejects an unknown default_persona at the schema layer", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(path, "default_persona: wizard\n");
    await expect(loadConfig({ globalPath: path, projectDir: dir })).rejects.toThrow(
      /CONFIG_INVALID/,
    );
  });

  it("merges mcp_servers across global and project (project wins by name)", async () => {
    const global = join(dir, "global.yaml");
    await writeFile(
      global,
      [
        "mcp_servers:",
        "  a:",
        "    command: global-a",
        "  shared:",
        "    command: global-shared",
      ].join("\n"),
    );
    const projectDir = join(dir, "proj");
    await mkdir(join(projectDir, ".cleetus"), { recursive: true });
    await writeFile(
      join(projectDir, ".cleetus", "config.yaml"),
      [
        "mcp_servers:",
        "  b:",
        "    command: project-b",
        "  shared:",
        "    command: project-shared",
      ].join("\n"),
    );
    const cfg = await loadConfig({ globalPath: global, projectDir });
    expect(cfg.mcpServers.a!.command).toBe("global-a");
    expect(cfg.mcpServers.b!.command).toBe("project-b");
    expect(cfg.mcpServers.shared!.command).toBe("project-shared"); // project wins
  });
});

describe("env interpolation in mcp_servers", () => {
  it("interpolates ${VAR} from process.env into env values", async () => {
    process.env.CLEETUS_TEST_TOKEN = "secret123";
    const path = join(dir, "config.yaml");
    await writeFile(
      path,
      [
        "mcp_servers:",
        "  s:",
        "    command: x",
        "    env:",
        "      TOKEN: ${CLEETUS_TEST_TOKEN}",
      ].join("\n"),
    );
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.mcpServers.s!.env.TOKEN).toBe("secret123");
    // biome-ignore lint/performance/noDelete: must truly unset the env var, not set it to the string "undefined"
    delete process.env.CLEETUS_TEST_TOKEN;
  });

  it("warns and yields empty string for a missing var", async () => {
    // biome-ignore lint/performance/noDelete: must truly unset the env var so interpolation sees it as missing
    delete process.env.CLEETUS_MISSING_VAR;
    const warn = spyOn(console, "error").mockImplementation(() => {});
    const path = join(dir, "config.yaml");
    await writeFile(
      path,
      [
        "mcp_servers:",
        "  s:",
        "    command: x",
        "    env:",
        "      TOKEN: ${CLEETUS_MISSING_VAR}",
      ].join("\n"),
    );
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.mcpServers.s!.env.TOKEN).toBe("");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("treats $${LITERAL} as an escaped literal ${LITERAL}", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(
      path,
      ["mcp_servers:", "  s:", "    command: x", "    env:", "      RAW: $${NOT_A_VAR}"].join("\n"),
    );
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.mcpServers.s!.env.RAW).toBe("${NOT_A_VAR}");
  });
});

describe("resolveRouting", () => {
  it("defaults to manual with smart defaults and no tiers when absent", () => {
    const r = resolveRouting(undefined, undefined);
    expect(r.defaultMode).toBe("manual");
    expect(r.tiers).toBeUndefined();
    expect(r.smart).toEqual(DEFAULT_SMART_CONFIG);
  });

  it("maps snake_case tiers and mode", () => {
    const r = resolveRouting(
      {
        default_mode: "smart",
        tiers: {
          small: { provider: "lm", model: "small-m" },
          large: { provider: "rm", model: "big-m" },
        },
      },
      undefined,
    );
    expect(r.defaultMode).toBe("smart");
    expect(r.tiers).toEqual({
      small: { provider: "lm", model: "small-m" },
      large: { provider: "rm", model: "big-m" },
    });
  });

  it("overrides global with project per field", () => {
    const g = { default_mode: "manual" as const, smart: { escalate_after_tools: 2 } };
    const p = { default_mode: "speed" as const };
    const r = resolveRouting(g, p);
    expect(r.defaultMode).toBe("speed"); // project wins
    expect(r.smart.escalateAfterFailures).toBe(2); // inherited from legacy global key
    expect(r.smart.contextWindowPercent).toBe(DEFAULT_SMART_CONFIG.contextWindowPercent);
  });

  it("prefers the canonical failure threshold while honoring legacy project overrides", () => {
    const canonical = resolveRouting(
      { smart: { escalate_after_failures: 4, escalate_after_tools: 8 } },
      undefined,
    );
    expect(canonical.smart.escalateAfterFailures).toBe(4);

    const projectLegacy = resolveRouting(
      { smart: { escalate_after_failures: 4 } },
      { smart: { escalate_after_tools: 2 } },
    );
    expect(projectLegacy.smart.escalateAfterFailures).toBe(2);
  });

  it("maps context pressure percent and safely ignores the legacy character threshold", () => {
    const canonical = resolveRouting({ smart: { context_window_percent: 80 } }, undefined);
    expect(canonical.smart.contextWindowPercent).toBe(80);

    const projectCanonical = resolveRouting(
      { smart: { context_char_threshold: 24_000 } },
      { smart: { context_window_percent: 75 } },
    );
    expect(projectCanonical.smart.contextWindowPercent).toBe(75);

    const legacy = resolveRouting({ smart: { context_char_threshold: 24_000 } }, undefined);
    expect(legacy.smart.contextWindowPercent).toBe(70);
  });

  it("replaces global tiers wholesale when project sets tiers", () => {
    const g = {
      tiers: {
        small: { provider: "g", model: "gs" },
        large: { provider: "g", model: "gl" },
      },
    };
    const p = {
      tiers: {
        small: { provider: "p", model: "ps" },
        large: { provider: "p", model: "pl" },
      },
    };
    const r = resolveRouting(g, p);
    expect(r.tiers).toEqual({
      small: { provider: "p", model: "ps" },
      large: { provider: "p", model: "pl" },
    });
  });
});

describe("resolveSandbox", () => {
  it("defaults to the host backend with network on", () => {
    expect(resolveSandbox(undefined, undefined)).toEqual({ backend: "host", network: true });
  });

  it("maps backend and image and network", () => {
    expect(
      resolveSandbox({ backend: "docker", image: "oven/bun:1", network: false }, undefined),
    ).toEqual({ backend: "docker", image: "oven/bun:1", network: false });
  });

  it("lets a project strengthen an explicit global none -> docker", () => {
    const r = resolveSandbox({ backend: "none" }, { backend: "docker", image: "img" });
    expect(r.backend).toBe("docker");
  });

  it("floors the backend: a project cannot weaken an explicit global docker -> none", () => {
    const r = resolveSandbox({ backend: "docker", image: "img" }, { backend: "none" });
    expect(r.backend).toBe("docker"); // global docker wins
  });

  it("floors the backend: a project cannot weaken an explicit global host -> none", () => {
    const r = resolveSandbox({ backend: "host" }, { backend: "none" });
    expect(r.backend).toBe("host");
  });

  it("does NOT floor when no global backend is set (project may choose none)", () => {
    expect(resolveSandbox(undefined, { backend: "none" }).backend).toBe("none");
    expect(resolveSandbox({ network: true }, { backend: "none" }).backend).toBe("none");
  });

  it("lets a project switch between host and docker (not ranked)", () => {
    expect(resolveSandbox({ backend: "host" }, { backend: "docker", image: "x" }).backend).toBe(
      "docker",
    );
    expect(resolveSandbox({ backend: "docker", image: "x" }, { backend: "host" }).backend).toBe(
      "host",
    );
  });

  it("lets a project override the image", () => {
    const r = resolveSandbox({ backend: "docker", image: "global-img" }, { image: "proj-img" });
    expect(r.image).toBe("proj-img");
  });

  it("resolves network project-over-global, default true", () => {
    expect(resolveSandbox(undefined, undefined).network).toBe(true);
    expect(resolveSandbox({ network: false }, undefined).network).toBe(false);
    expect(resolveSandbox({ network: false }, { network: true }).network).toBe(true);
  });

  it("defaults ui to the dark theme with no overrides when absent", async () => {
    const cfg = await loadConfig({ globalPath: join(dir, "missing.yaml"), projectDir: dir });
    expect(cfg.ui).toEqual({ theme: "dark", colors: {} });
  });

  it("flows a ui block through, mapping snake_case overrides to camelCase roles", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(
      path,
      "ui:\n  theme: light\n  colors:\n    code: '#73daca'\n    tool_line: '#7aa2f7'\n",
    );
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.ui.theme).toBe("light");
    expect(cfg.ui.colors).toEqual({ code: "#73daca", toolLine: "#7aa2f7" });
  });
});

describe("default_personality", () => {
  it("defaults to neutral when unset", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(path, "providers: {}\n");
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.defaultPersonality).toBe("neutral");
  });

  it("takes the project value over global", async () => {
    const global = join(dir, "global.yaml");
    await writeFile(global, "default_personality: cleetus\n");
    const projectDir = join(dir, "proj");
    await mkdir(join(projectDir, ".cleetus"), { recursive: true });
    await writeFile(join(projectDir, ".cleetus", "config.yaml"), "default_personality: bofh\n");
    const cfg = await loadConfig({ globalPath: global, projectDir });
    expect(cfg.defaultPersonality).toBe("bofh");
  });

  describe("personality_correction", () => {
    it("defaults to false when unset", async () => {
      const path = join(dir, "config.yaml");
      await writeFile(path, "providers: {}\n");
      const cfg = await loadConfig({ globalPath: path, projectDir: dir });
      expect(cfg.personalityCorrection).toBe(false);
    });

    it("honors an explicit true", async () => {
      const path = join(dir, "config.yaml");
      await writeFile(path, "personality_correction: true\n");
      const cfg = await loadConfig({ globalPath: path, projectDir: dir });
      expect(cfg.personalityCorrection).toBe(true);
    });

    it("takes the project value over global", async () => {
      const global = join(dir, "global.yaml");
      await writeFile(global, "personality_correction: true\n");
      const projectDir = join(dir, "proj");
      await mkdir(join(projectDir, ".cleetus"), { recursive: true });
      await writeFile(
        join(projectDir, ".cleetus", "config.yaml"),
        "personality_correction: false\n",
      );
      const cfg = await loadConfig({ globalPath: global, projectDir });
      expect(cfg.personalityCorrection).toBe(false);
    });
  });

  it("defaults capability to auto and honors an explicit value", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(
      path,
      "providers:\n  lm:\n    type: lmstudio\n    base_url: http://localhost:1234\ndefault_provider: lm\n",
    );
    const cfg = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg.capability).toBe("auto");

    await writeFile(
      path,
      "providers:\n  lm:\n    type: lmstudio\n    base_url: http://localhost:1234\ndefault_provider: lm\ncapability: small\n",
    );
    const cfg2 = await loadConfig({ globalPath: path, projectDir: dir });
    expect(cfg2.capability).toBe("small");
  });

  describe("system_prompt_file", () => {
    it("is undefined when unset", async () => {
      const path = join(dir, "config.yaml");
      await writeFile(path, "default_persona: coding\n");
      const cfg = await loadConfig({ globalPath: path, projectDir: dir });
      expect(cfg.systemPromptFile).toBeUndefined();
    });

    it("resolves a relative project value against projectDir", async () => {
      const global = join(dir, "global.yaml");
      await writeFile(global, "default_persona: coding\n");
      const projectDir = join(dir, "proj");
      await mkdir(join(projectDir, ".cleetus"), { recursive: true });
      await writeFile(
        join(projectDir, ".cleetus", "config.yaml"),
        "system_prompt_file: prompts/mine.txt\n",
      );
      const cfg = await loadConfig({ globalPath: global, projectDir });
      expect(cfg.systemPromptFile).toBe(join(projectDir, "prompts", "mine.txt"));
    });

    it("resolves a relative global value against the global config dir", async () => {
      const globalDir = join(dir, "g");
      await mkdir(globalDir, { recursive: true });
      const global = join(globalDir, "config.yaml");
      await writeFile(global, "system_prompt_file: sys.txt\n");
      const cfg = await loadConfig({ globalPath: global, projectDir: dir });
      expect(cfg.systemPromptFile).toBe(join(globalDir, "sys.txt"));
    });

    it("project wins over global", async () => {
      const globalDir = join(dir, "g");
      await mkdir(globalDir, { recursive: true });
      const global = join(globalDir, "config.yaml");
      await writeFile(global, "system_prompt_file: sys.txt\n");
      const projectDir = join(dir, "proj");
      await mkdir(join(projectDir, ".cleetus"), { recursive: true });
      await writeFile(
        join(projectDir, ".cleetus", "config.yaml"),
        "system_prompt_file: mine.txt\n",
      );
      const cfg = await loadConfig({ globalPath: global, projectDir });
      expect(cfg.systemPromptFile).toBe(join(projectDir, "mine.txt"));
    });

    it("passes an absolute value through unchanged", async () => {
      const path = join(dir, "config.yaml");
      await writeFile(path, "system_prompt_file: /abs/prompt.txt\n");
      const cfg = await loadConfig({ globalPath: path, projectDir: dir });
      expect(cfg.systemPromptFile).toBe("/abs/prompt.txt");
    });
  });
});

describe("global_workspace_dir", () => {
  it("is read from the global config", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cfg-"));
    const globalPath = join(configDir, "config.yaml");
    await writeFile(globalPath, "global_workspace_dir: /tmp/my-global\n");
    const config = await loadConfig({ globalPath, projectDir: configDir });
    expect(config.globalWorkspaceDir).toBe("/tmp/my-global");
    await rm(configDir, { recursive: true, force: true });
  });

  it("is undefined when unset", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cfg-"));
    const globalPath = join(configDir, "config.yaml");
    await writeFile(globalPath, "providers: {}\n");
    const config = await loadConfig({ globalPath, projectDir: configDir });
    expect(config.globalWorkspaceDir).toBeUndefined();
    await rm(configDir, { recursive: true, force: true });
  });
});

it("merges exact per-provider model profiles field by field", async () => {
  const globalPath = join(dir, "global.yaml");
  await writeFile(
    globalPath,
    'model_profiles:\n  local:\n    "9b":\n      capability: small\n      max_budget_tokens: 24000\n    "35b":\n      capability: standard\n',
  );
  await mkdir(join(dir, ".cleetus"));
  await writeFile(
    join(dir, ".cleetus/config.yaml"),
    'model_profiles:\n  local:\n    "9b":\n      max_budget_tokens: 16000\n',
  );
  const config = await loadConfig({ globalPath, projectDir: dir });
  expect(config.modelProfiles?.local?.["9b"]).toEqual({
    capability: "small",
    max_budget_tokens: 16000,
  });
  expect(config.modelProfiles?.local?.["35b"]).toEqual({ capability: "standard" });
});
