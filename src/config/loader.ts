import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_EFFORT } from "../agent/effort";
import { DEFAULT_PERSONALITY } from "../agent/personalities";
import { DEFAULT_PERSONA } from "../agent/personas";
import { CleetusError } from "../lib/errors";
import { readTrustedProjectFile } from "../security/project-trust";
import { resolveAttachments } from "./attachments";
import { resolveBuildGate } from "./build-gate";
import { resolveCheckpoint } from "./checkpoint";
import { resolveContext } from "./context";
import { resolveDiagnostics } from "./diagnostics";
import { resolveFormat } from "./format";
import { resolveHooks } from "./hooks";
import { DEFAULT_MAX_TOOL_LOOPS } from "./loop-cap";
import { resolveLoopGuard } from "./loop-guard";
import { resolveMalformedPath } from "./malformed-path";
import { resolveModelFamily } from "./model-family";
import { resolveOrchestration } from "./orchestration";
import { resolvePackageManager } from "./package-manager";
import { resolvePlanModeGuard } from "./plan-mode";
import { resolvePlanOrGo } from "./plan-or-go";
import { resolveRepoMap } from "./repo-map";
import { resolveResize } from "./resize";
import { resolveRouting } from "./routing";
import { resolveSandbox } from "./sandbox";
import { type RawConfig, RawConfigSchema } from "./schema";
import { resolveSkills } from "./skills";
import { resolveSmokeRun } from "./smoke-run";
import { resolveSpecs } from "./specs";
import { resolveStreamWatchdog } from "./stream-watchdog";
import { resolveStreaming } from "./streaming";
import { resolveSubagents } from "./subagents";
import { resolveTest } from "./test";
import type { CleetusConfig, McpServerConfig, ProviderConfig } from "./types";
import { resolveUi } from "./ui";
import { resolveVision } from "./vision";
import { resolveWebTools } from "./web-tools";

export const DEFAULT_STRUCTURED_OUTPUT = "auto" as const;
export const DEFAULT_CAPABILITY = "auto" as const;

// Matches ${VAR} (interpolate) and $${VAR} (escaped literal). The optional inner
// "$" (group 1) marks an escape; group 2 is the variable name.
const ENV_PATTERN = /\$(\$?)\{([A-Z0-9_]+)\}/g;

function interpolateEnv(value: string): string {
  return value.replace(ENV_PATTERN, (_match, escaped: string, name: string) => {
    if (escaped) return `\${${name}}`; // $${VAR} -> literal ${VAR}
    const resolved = process.env[name];
    if (resolved === undefined) {
      console.error(
        `[cleetus] WARNING: config references undefined env var \${${name}} (using empty string)`,
      );
      return "";
    }
    return resolved;
  });
}

function interpolateDeep<T>(input: T): T {
  if (typeof input === "string") return interpolateEnv(input) as T;
  if (Array.isArray(input)) return input.map(interpolateDeep) as T;
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = interpolateDeep(v);
    return out as T;
  }
  return input;
}

async function readYaml(path: string, approvedText?: string | null): Promise<RawConfig | null> {
  if (approvedText === null) return null;
  let text: string;
  try {
    text = approvedText ?? (await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CleetusError("IO_FAILED", `failed to read ${path}`, { cause: e });
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new CleetusError("CONFIG_INVALID", `invalid YAML in ${path}: ${(e as Error).message}`);
  }
  const parsed = RawConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new CleetusError("CONFIG_INVALID", `invalid config in ${path}: ${parsed.error.message}`);
  }
  return interpolateDeep(parsed.data);
}

function normalize(raw: RawConfig): Partial<CleetusConfig> {
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, p] of Object.entries(raw.providers ?? {})) {
    providers[name] = { type: p.type, baseUrl: p.base_url, apiKey: p.api_key };
  }
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, s] of Object.entries(raw.mcp_servers ?? {})) {
    mcpServers[name] = { command: s.command, args: s.args, env: s.env, enabled: s.enabled };
  }
  return {
    providers,
    mcpServers,
    embeddings: raw.embeddings
      ? { provider: raw.embeddings.provider, model: raw.embeddings.model }
      : undefined,
    defaultProvider: raw.default_provider,
    defaultModel: raw.default_model,
    globalWorkspaceDir: raw.global_workspace_dir,
    permissionsDisabled: raw.permissions_disabled,
    maxToolLoops: raw.max_tool_loops,
    defaultPersona: raw.default_persona,
    defaultEffort: raw.default_effort,
    defaultPersonality: raw.default_personality,
    personalityCorrection: raw.personality_correction,
    systemPromptFile: raw.system_prompt_file,
    structuredOutput: raw.structured_output,
    capability: raw.capability,
  };
}

/** Resolve a scope-relative path against that scope's own directory: project values against
 *  projectDir, global values against the global config file's directory (audit F8). */
function resolveScopedPath(val: string | undefined, baseDir: string): string | undefined {
  if (val == null) return undefined;
  return isAbsolute(val) ? val : resolve(baseDir, val);
}

export interface LoadConfigOptions {
  globalPath: string;
  projectDir: string;
  trustStoreDir?: string;
}

export async function loadConfig(opts: LoadConfigOptions): Promise<CleetusConfig> {
  const global = await readYaml(opts.globalPath);
  const project = await readYaml(
    join(opts.projectDir, ".cleetus", "config.yaml"),
    await readTrustedProjectFile(opts, "config.yaml"),
  );

  const g = global ? normalize(global) : {};
  const p = project ? normalize(project) : {};

  return {
    providers: { ...(g.providers ?? {}), ...(p.providers ?? {}) },
    mcpServers: { ...(g.mcpServers ?? {}), ...(p.mcpServers ?? {}) },
    embeddings: p.embeddings ?? g.embeddings,
    defaultProvider: p.defaultProvider ?? g.defaultProvider,
    defaultModel: p.defaultModel ?? g.defaultModel,
    globalWorkspaceDir: p.globalWorkspaceDir ?? g.globalWorkspaceDir,
    permissionsDisabled: p.permissionsDisabled ?? g.permissionsDisabled,
    maxToolLoops: p.maxToolLoops ?? g.maxToolLoops ?? DEFAULT_MAX_TOOL_LOOPS,
    defaultPersona: p.defaultPersona ?? g.defaultPersona ?? DEFAULT_PERSONA,
    defaultEffort: p.defaultEffort ?? g.defaultEffort ?? DEFAULT_EFFORT,
    defaultPersonality: p.defaultPersonality ?? g.defaultPersonality ?? DEFAULT_PERSONALITY,
    personalityCorrection: p.personalityCorrection ?? g.personalityCorrection ?? false,
    systemPromptFile:
      resolveScopedPath(p.systemPromptFile, opts.projectDir) ??
      resolveScopedPath(g.systemPromptFile, dirname(opts.globalPath)),
    structuredOutput: p.structuredOutput ?? g.structuredOutput ?? DEFAULT_STRUCTURED_OUTPUT,
    capability: p.capability ?? g.capability ?? DEFAULT_CAPABILITY,
    modelProfiles: Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(global?.model_profiles ?? {}),
          ...Object.keys(project?.model_profiles ?? {}),
        ]),
      ].map((provider) => [
        provider,
        Object.fromEntries(
          [
            ...new Set([
              ...Object.keys(global?.model_profiles?.[provider] ?? {}),
              ...Object.keys(project?.model_profiles?.[provider] ?? {}),
            ]),
          ].map((model) => [
            model,
            {
              ...global?.model_profiles?.[provider]?.[model],
              ...project?.model_profiles?.[provider]?.[model],
            },
          ]),
        ),
      ]),
    ),
    routing: resolveRouting(global?.routing, project?.routing),
    sandbox: resolveSandbox(global?.sandbox, project?.sandbox),
    webTools: resolveWebTools(global?.web_tools, project?.web_tools),
    repoMap: resolveRepoMap(global?.repo_map, project?.repo_map),
    streaming: resolveStreaming(global?.streaming, project?.streaming),
    context: resolveContext(global?.context, project?.context),
    loopGuard: resolveLoopGuard(global?.loop_guard, project?.loop_guard),
    planMode: resolvePlanModeGuard(global?.plan_mode, project?.plan_mode),
    streamWatchdog: resolveStreamWatchdog(global?.stream_watchdog, project?.stream_watchdog),
    vision: resolveVision(global?.vision, project?.vision),
    attachments: resolveAttachments(global?.attachments, project?.attachments),
    resize: resolveResize(global?.resize, project?.resize),
    malformedPath: resolveMalformedPath(global?.malformed_path, project?.malformed_path),
    orchestration: resolveOrchestration(global?.orchestration, project?.orchestration),
    skills: resolveSkills(global?.skills, project?.skills),
    specs: resolveSpecs(global?.specs, project?.specs),
    subagents: resolveSubagents(global?.subagents, project?.subagents),
    packageManager: resolvePackageManager(global?.package_manager, project?.package_manager),
    hooks: resolveHooks(global?.hooks, project?.hooks),
    modelFamily: resolveModelFamily(global?.model_family, project?.model_family),
    planOrGo: resolvePlanOrGo(global?.plan_or_go, project?.plan_or_go),
    diagnostics: resolveDiagnostics(global?.diagnostics, project?.diagnostics),
    format: resolveFormat(global?.format, project?.format),
    test: resolveTest(global?.test, project?.test),
    smokeRun: resolveSmokeRun(global?.smoke_run, project?.smoke_run),
    buildGate: resolveBuildGate(global?.build_gate, project?.build_gate),
    checkpoint: resolveCheckpoint(global?.checkpoint, project?.checkpoint),
    ui: resolveUi(global?.ui, project?.ui),
  };
}
