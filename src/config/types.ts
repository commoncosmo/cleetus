import type { EffortLevel } from "../agent/effort";
import type { HookEntry } from "../hooks/types";
import type { ModelFamilyName } from "../providers/families/types";
import type { ThemeName, ThemeOverrides } from "../ui/theme";
import type { AttachmentsConfig } from "./attachments";
import type { BuildGateConfig } from "./build-gate";
import type { ContextConfig } from "./context";
import type { LoopGuardConfig } from "./loop-guard";
import type { MalformedPathConfig } from "./malformed-path";
import type { OrchestrationConfig } from "./orchestration";
import type { PlanModeGuardConfig } from "./plan-mode";
import type { ResizeConfig } from "./resize";
import type { SmokeRunConfig } from "./smoke-run";
import type { StreamWatchdogConfig } from "./stream-watchdog";
import type { VisionConfig } from "./vision";

export type ProviderType = "lmstudio" | "ollama" | "llama.cpp";

export interface ProviderConfig {
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export interface EmbeddingsConfig {
  provider: string;
  model: string;
}

export interface TierChoice {
  provider: string;
  model: string;
}

export interface SmartConfig {
  /** Escalate after this many consecutive failed tool outcomes in the current turn. */
  escalateAfterFailures: number;
  /** Release an active recovery lease after this many consecutive successful tool outcomes. */
  deescalateAfterSuccesses: number;
  /** Escalate when assembled input reaches this percentage of its usable context capacity. */
  contextWindowPercent: number;
  /**
   * "always" escalates on any implementation-file write and holds until a passing test/render/
   * build verification (the historical behavior). "on_verify_fail" leaves the current tier in
   * place through the write and escalates only once a qualifying verification fails. "never"
   * disables both this and the upfront broad-code escalation.
   */
  escalateOnCodeEdit: "always" | "on_verify_fail" | "never";
  keywords: string[];
  /** Escalate an explicit build request (`taskClass === "broad_code"`) only until a `todo_write`
   *  call has been observed in the current turn, or this many model calls have happened,
   *  whichever comes first. A backstop for a model that never establishes a checklist. */
  broadCodePlanCalls: number;
}

export interface RoutingConfig {
  defaultMode: "manual" | "speed" | "smart";
  tiers?: { small: TierChoice; large: TierChoice };
  smart: SmartConfig;
}

export interface SandboxConfig {
  backend: "none" | "host" | "docker";
  image?: string;
  network: boolean;
}

export interface WebSearchConfig {
  provider: "duckduckgo" | "brave";
  braveApiKey?: string;
}

export interface WebToolsConfig {
  enabled: boolean;
  allowLocalhost: boolean;
  maxBytes: number;
  search: WebSearchConfig;
}

export interface RepoMapConfig {
  enabled: boolean;
  tokenBudget: number;
}

export interface StreamingConfig {
  enabled: boolean;
  reasoning: boolean;
  reasoningLines: number;
  proseLines: number;
}

export interface SkillsConfig {
  enabled: boolean;
  autoInvoke: boolean;
}

export interface SpecsConfig {
  /** Directory new specs are written to (relative to the project root). */
  dir: string;
}

export interface SubagentsConfig {
  enabled: boolean;
}

export interface PackageManagerConfig {
  /** When true (default), the bash tool blocks a foreign package manager (npx/npm/yarn/pnpm) in a
   *  project that has a Bun lockfile, returning the Bun equivalent. Set false to allow them — the
   *  escape hatch for a deliberate one-off npm/npx command. */
  enforceBun: boolean;
}

export interface ModelFamilyConfig {
  enabled: boolean;
  override?: ModelFamilyName;
}

export interface PlanOrGoConfig {
  enabled: boolean;
}

export interface DiagnosticsConfig {
  enabled: boolean;
  languages?: ("typescript" | "python" | "go" | "rust")[];
  timeoutMs: number;
  maxReported: number;
}

export interface FormatConfig {
  /** Run a post-write formatter over edited files. */
  enabled: boolean;
}

export interface TestConfig {
  enabled: boolean;
  command?: string | string[];
  timeoutMs: number;
  maxOutputLines: number;
}

export interface CheckpointConfig {
  enabled: boolean;
  maxCheckpoints: number;
}

export interface UiConfig {
  theme: ThemeName;
  colors: ThemeOverrides;
}

export interface ModelProfile {
  capability?: "small" | "standard" | "auto";
  max_budget_tokens?: number;
}

export interface CleetusConfig {
  providers: Record<string, ProviderConfig>;
  mcpServers: Record<string, McpServerConfig>;
  embeddings?: EmbeddingsConfig;
  defaultProvider?: string;
  defaultModel?: string;
  /** Working directory for `--global` mode. Raw string as configured (relative → home,
   *  `~/` expanded, env-interpolated); normalized to absolute by resolveLaunchScope. Unset → ~/.cleetus. */
  globalWorkspaceDir?: string;
  permissionsDisabled?: boolean;
  maxToolLoops: number;
  defaultPersona: "coding" | "chat" | "concise" | "general";
  defaultEffort: EffortLevel;
  defaultPersonality: "neutral" | "cleetus" | "bofh";
  /** When true, a non-neutral personality runs a bounded prose-only rewrite pass (one extra
   *  model call) if the finished draft lacks the active voice. Off by default — the overlay and
   *  per-turn reminder still apply the voice on the first pass regardless. */
  personalityCorrection: boolean;
  /** Absolute path to a file whose contents replace the persona fragment verbatim (audit F8).
   *  Resolved by the loader against the owning scope's directory. Unset → built-in personas. */
  systemPromptFile?: string;
  structuredOutput: "auto" | "off";
  capability: "small" | "standard" | "auto";
  modelProfiles?: Record<string, Record<string, ModelProfile>>;
  routing: RoutingConfig;
  sandbox: SandboxConfig;
  webTools: WebToolsConfig;
  repoMap: RepoMapConfig;
  streaming: StreamingConfig;
  context: ContextConfig;
  loopGuard: LoopGuardConfig;
  planMode: PlanModeGuardConfig;
  streamWatchdog: StreamWatchdogConfig;
  vision: VisionConfig;
  attachments: AttachmentsConfig;
  resize: ResizeConfig;
  malformedPath: MalformedPathConfig;
  orchestration: OrchestrationConfig;
  skills: SkillsConfig;
  specs: SpecsConfig;
  subagents: SubagentsConfig;
  packageManager: PackageManagerConfig;
  hooks: HookEntry[];
  modelFamily: ModelFamilyConfig;
  planOrGo: PlanOrGoConfig;
  diagnostics: DiagnosticsConfig;
  format: FormatConfig;
  test: TestConfig;
  smokeRun: SmokeRunConfig;
  buildGate: BuildGateConfig;
  checkpoint: CheckpointConfig;
  ui: UiConfig;
}
