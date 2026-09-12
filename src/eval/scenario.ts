import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface Scenario {
  name: string;
  prompt: string;
  check: string;
  checkTimeoutMs: number;
  agentTimeoutMs: number;
  fixtureDir: string | null;
}

const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
const DEFAULT_AGENT_TIMEOUT_MS = 300_000;

/** Load every scenario subdirectory of `dir`. Returns [] when `dir` is absent. */
export function loadScenarios(dir: string): Scenario[] {
  if (!existsSync(dir)) return [];
  const out: Scenario[] = [];
  for (const name of readdirSync(dir).sort()) {
    const scnDir = join(dir, name);
    if (!statSync(scnDir).isDirectory()) continue;
    const manifestPath = join(scnDir, "scenario.yaml");
    if (!existsSync(manifestPath)) continue;
    const raw = parseYaml(readFileSync(manifestPath, "utf8")) as Record<string, unknown> | null;
    if (!raw || typeof raw.prompt !== "string" || typeof raw.check !== "string") {
      throw new Error(`scenario '${name}': scenario.yaml must define string 'prompt' and 'check'`);
    }
    const fixtureDir = join(scnDir, "fixture");
    out.push({
      name,
      prompt: raw.prompt,
      check: raw.check,
      checkTimeoutMs:
        typeof raw.check_timeout_ms === "number" ? raw.check_timeout_ms : DEFAULT_CHECK_TIMEOUT_MS,
      agentTimeoutMs:
        typeof raw.agent_timeout_ms === "number" ? raw.agent_timeout_ms : DEFAULT_AGENT_TIMEOUT_MS,
      fixtureDir: existsSync(fixtureDir) && statSync(fixtureDir).isDirectory() ? fixtureDir : null,
    });
  }
  return out;
}
