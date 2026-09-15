import { existsSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { CleetusConfig, ProviderConfig, ProviderType } from "../config/types";
import { buildProvider } from "../providers/factory";
import { privateDirectory, writePrivateFile } from "../security/private-state";

export interface DetectedProvider {
  type: ProviderType;
  baseUrl: string;
  models: string[];
}

export interface DetectDeps {
  candidates?: { type: ProviderType; baseUrl: string }[];
  probe?: (type: ProviderType, baseUrl: string) => Promise<string[]>;
  timeoutMs?: number;
}

const DEFAULT_CANDIDATES: { type: ProviderType; baseUrl: string }[] = [
  { type: "lmstudio", baseUrl: "http://localhost:1234" },
  { type: "ollama", baseUrl: "http://localhost:11434" },
  { type: "llama.cpp", baseUrl: "http://localhost:8080" },
];
const DEFAULT_TIMEOUT_MS = 1500;

async function defaultProbe(type: ProviderType, baseUrl: string): Promise<string[]> {
  const models = await buildProvider(type, baseUrl).listModels();
  return models.map((m) => m.id);
}

// Races a probe against a timeout. The probe itself is NOT aborted on timeout — fine here:
// detection is a short startup path and a dangling listModels() fetch is reclaimed at teardown.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

/** Probe the well-known local provider endpoints; return those that respond with ≥1 model. */
export async function detectLocalProviders(deps: DetectDeps = {}): Promise<DetectedProvider[]> {
  const candidates = deps.candidates ?? DEFAULT_CANDIDATES;
  const probe = deps.probe ?? defaultProbe;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const results = await Promise.all(
    candidates.map(async (c): Promise<DetectedProvider | null> => {
      try {
        const models = await withTimeout(probe(c.type, c.baseUrl), timeoutMs);
        return models.length > 0 ? { type: c.type, baseUrl: c.baseUrl, models } : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is DetectedProvider => r !== null);
}

const SCAFFOLD_CONFIG = `# cleetus configuration — uncomment a provider, then re-run \`cleetus\`.
# providers:
#   lmstudio:
#     type: lmstudio
#     base_url: http://localhost:1234
#   ollama:
#     type: ollama
#     base_url: http://localhost:11434
#   llama-cpp:
#     type: llama.cpp
#     base_url: http://localhost:8080
# default_provider: lmstudio
# default_model: your-model-id
`;

const SCAFFOLD_INSTRUCTIONS = `# Instructions for cleetus (optional). Anything here is prepended to the agent's system prompt.
`;

/** Write a WORKING config.yaml from a detection. Write-if-absent: returns null if it already exists. */
export function writeDetectedConfig(
  globalDir: string,
  detected: DetectedProvider[],
): string | null {
  if (detected.length === 0) return null;
  const path = join(globalDir, "config.yaml");
  if (existsSync(path)) return null;
  const providers: Record<string, { type: string; base_url: string }> = {};
  for (const d of detected) providers[d.type] = { type: d.type, base_url: d.baseUrl };
  const first = detected[0];
  const doc = {
    providers,
    default_provider: first?.type,
    default_model: first?.models[0],
  };
  privateDirectory(globalDir);
  writePrivateFile(path, stringifyYaml(doc));
  return path;
}

/** Write a commented starter config.yaml + instructions.md (write-if-absent). Returns the config path. */
export function scaffoldConfig(globalDir: string): string {
  privateDirectory(globalDir);
  const configPath = join(globalDir, "config.yaml");
  if (!existsSync(configPath)) writePrivateFile(configPath, SCAFFOLD_CONFIG);
  const instrPath = join(globalDir, "instructions.md");
  if (!existsSync(instrPath)) writePrivateFile(instrPath, SCAFFOLD_INSTRUCTIONS);
  return configPath;
}

export type FirstRunResult =
  | { action: "continue"; config: CleetusConfig; message: string }
  | { action: "exit"; message: string };

/** First-run orchestrator: detect a local provider and continue, or scaffold and exit. */
export async function firstRunSetup(
  config: CleetusConfig,
  globalDir: string,
  deps: { detect?: () => Promise<DetectedProvider[]> } = {},
): Promise<FirstRunResult> {
  const detect = deps.detect ?? detectLocalProviders;
  const detected = await detect();

  if (detected.length > 0) {
    const providers: Record<string, ProviderConfig> = {};
    for (const d of detected) providers[d.type] = { type: d.type, baseUrl: d.baseUrl };
    const first = detected[0]!;
    const populated: CleetusConfig = {
      ...config,
      providers,
      defaultProvider: first.type,
      defaultModel: first.models[0],
    };
    const written = writeDetectedConfig(globalDir, detected);
    const message = written
      ? `detected ${first.type} at ${first.baseUrl} — wrote ${written}`
      : `detected ${first.type} at ${first.baseUrl} — using it for this session (existing config.yaml left untouched)`;
    return { action: "continue", config: populated, message };
  }

  const path = scaffoldConfig(globalDir);
  return {
    action: "exit",
    message: `no local LM Studio, Ollama, or llama.cpp server found — wrote a starter config at ${path}; add a provider and re-run`,
  };
}
