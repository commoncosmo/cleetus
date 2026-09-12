import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModelChoice } from "../agent/selector";

export interface CandidateRoutingOverride {
  mode?: "manual" | "speed" | "smart";
  tiers?: { small: ModelChoice; large: ModelChoice };
}
export interface Candidate {
  name: string;
  systemPrompt?: string;
  tools?: string[];
  routing?: CandidateRoutingOverride;
}

/** The implicit candidate: every field undefined, so it inherits the live baseline. */
export const BASELINE: Candidate = Object.freeze({ name: "baseline" });

/** Load every `<name>.yaml` in `dir` as a Candidate. Returns [] when `dir` is absent. */
export function loadCandidates(dir: string): Candidate[] {
  if (!existsSync(dir)) return [];
  const out: Candidate[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const name = file.replace(/\.(yaml|yml)$/, "");
    const raw = (parseYaml(readFileSync(join(dir, file), "utf8")) ?? {}) as Record<string, unknown>;
    const candidate: Candidate = { name };
    if (typeof raw.system_prompt === "string") candidate.systemPrompt = raw.system_prompt;
    if (Array.isArray(raw.tools)) candidate.tools = raw.tools.map(String);
    if (raw.routing && typeof raw.routing === "object") {
      const r = raw.routing as Record<string, unknown>;
      const routing: CandidateRoutingOverride = {};
      if (r.mode === "manual" || r.mode === "speed" || r.mode === "smart") routing.mode = r.mode;
      if (r.tiers && typeof r.tiers === "object") {
        const t = r.tiers as Record<string, unknown>;
        const s = t.small as Record<string, unknown> | undefined;
        const l = t.large as Record<string, unknown> | undefined;
        if (
          typeof s?.provider === "string" &&
          typeof s?.model === "string" &&
          typeof l?.provider === "string" &&
          typeof l?.model === "string"
        ) {
          routing.tiers = {
            small: { provider: s.provider, model: s.model },
            large: { provider: l.provider, model: l.model },
          };
        }
      }
      if (Object.keys(routing).length > 0) candidate.routing = routing;
    }
    out.push(candidate);
  }
  return out;
}
