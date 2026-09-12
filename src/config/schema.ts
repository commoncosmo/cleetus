import { z } from "zod";

export const ProviderConfigSchema = z.object({
  type: z.enum(["lmstudio", "ollama", "llama.cpp"]),
  base_url: z.string().url(),
  api_key: z.string().optional(),
});

export const McpServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});

export const EmbeddingsConfigSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
  })
  .optional();

const TierSchema = z.object({ provider: z.string(), model: z.string() });

export const RoutingObjectSchema = z.object({
  default_mode: z.enum(["manual", "speed", "smart"]).optional(),
  tiers: z.object({ small: TierSchema, large: TierSchema }).optional(),
  smart: z
    .object({
      escalate_after_failures: z.number().int().positive().optional(),
      /** @deprecated Use escalate_after_failures. Kept so existing configs remain valid. */
      escalate_after_tools: z.number().int().positive().optional(),
      deescalate_after_successes: z.number().int().positive().optional(),
      context_window_percent: z.number().positive().max(100).optional(),
      /** @deprecated Use context_window_percent. Kept so existing configs remain valid. */
      context_char_threshold: z.number().int().positive().optional(),
      escalate_on_code_edit: z
        .union([z.boolean(), z.enum(["always", "on_verify_fail", "never"])])
        .optional(),
      keywords: z.array(z.string()).optional(),
      broad_code_plan_calls: z.number().int().positive().optional(),
    })
    .optional(),
});

export type RawRouting = z.infer<typeof RoutingObjectSchema>;

export const SandboxObjectSchema = z.object({
  backend: z.enum(["none", "host", "docker"]).optional(),
  image: z.string().optional(),
  network: z.boolean().optional(),
});

export type RawSandbox = z.infer<typeof SandboxObjectSchema>;

export const WebToolsObjectSchema = z.object({
  enabled: z.boolean().optional(),
  allow_localhost: z.boolean().optional(),
  max_bytes: z.number().int().positive().optional(),
  search: z
    .object({
      provider: z.enum(["duckduckgo", "brave"]).optional(),
      brave_api_key: z.string().optional(),
    })
    .optional(),
});

export type RawWebTools = z.infer<typeof WebToolsObjectSchema>;

export const RepoMapObjectSchema = z.object({
  enabled: z.boolean().optional(),
  token_budget: z.number().int().positive().optional(),
});

export type RawRepoMap = z.infer<typeof RepoMapObjectSchema>;

export const StreamingObjectSchema = z.object({
  enabled: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_lines: z.number().int().min(1).optional(),
  prose_lines: z.number().int().min(1).optional(),
});

export type RawStreaming = z.infer<typeof StreamingObjectSchema>;

export const SkillsObjectSchema = z.object({
  enabled: z.boolean().optional(),
  auto_invoke: z.boolean().optional(),
});

export type RawSkills = z.infer<typeof SkillsObjectSchema>;

export const SpecsObjectSchema = z.object({
  dir: z.string().optional(),
});

export type RawSpecs = z.infer<typeof SpecsObjectSchema>;

export const SubagentsObjectSchema = z.object({
  enabled: z.boolean().optional(),
});

export type RawSubagents = z.infer<typeof SubagentsObjectSchema>;

export const HookEntrySchema = z
  .object({
    event: z.enum(["pre_tool_use", "post_tool_use"]),
    matcher: z.string().optional(),
    command: z.string().min(1),
    timeout_ms: z.number().int().positive().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.matcher) {
      try {
        new RegExp(val.matcher);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid hook matcher regex: ${val.matcher}`,
        });
      }
    }
  });
export const HooksSchema = z.array(HookEntrySchema);
export type RawHooks = z.infer<typeof HooksSchema>;

export const ModelFamilyObjectSchema = z.object({
  enabled: z.boolean().optional(),
  override: z.enum(["gpt-oss", "qwen", "gemma", "granite"]).optional(),
});

export type RawModelFamily = z.infer<typeof ModelFamilyObjectSchema>;

export const PlanOrGoObjectSchema = z.object({
  enabled: z.boolean().optional(),
});

export type RawPlanOrGo = z.infer<typeof PlanOrGoObjectSchema>;

export const DiagnosticsObjectSchema = z.object({
  enabled: z.boolean().optional(),
  languages: z.array(z.enum(["typescript", "python", "go", "rust"])).optional(),
  timeout_ms: z.number().int().positive().optional(),
  max_reported: z.number().int().positive().optional(),
});

export type RawDiagnostics = z.infer<typeof DiagnosticsObjectSchema>;

export const FormatObjectSchema = z.object({
  enabled: z.boolean().optional(),
});

export type RawFormat = z.infer<typeof FormatObjectSchema>;

export const TestObjectSchema = z.object({
  enabled: z.boolean().optional(),
  command: z.union([z.string().min(1), z.array(z.string()).min(1)]).optional(),
  timeout_ms: z.number().int().positive().optional(),
  max_output_lines: z.number().int().positive().optional(),
});

export type RawTest = z.infer<typeof TestObjectSchema>;

export const SmokeRunObjectSchema = z.object({
  default_seconds: z.number().int().positive().optional(),
  max_seconds: z.number().int().positive().optional(),
  max_output_lines: z.number().int().positive().optional(),
});

export type RawSmokeRun = z.infer<typeof SmokeRunObjectSchema>;

export const PackageManagerObjectSchema = z.object({
  enforce_bun: z.boolean().optional(),
});

export type RawPackageManager = z.infer<typeof PackageManagerObjectSchema>;

export const CheckpointObjectSchema = z.object({
  enabled: z.boolean().optional(),
  max_checkpoints: z.number().int().positive().optional(),
});

export type RawCheckpoint = z.infer<typeof CheckpointObjectSchema>;

export const LoopGuardObjectSchema = z.object({
  enabled: z.boolean().optional(),
  edit_repeat_threshold: z.number().int().positive().optional(),
  fail_repeat_threshold: z.number().int().positive().optional(),
  window_size: z.number().int().positive().optional(),
  cooldown: z.number().int().positive().optional(),
  no_progress_threshold: z.number().int().positive().optional(),
  escape_threshold: z.number().int().positive().optional(),
  block_threshold: z.number().int().nonnegative().optional(),
  hidden_repeat_threshold: z.number().int().positive().optional(),
  cmd_fail_abort: z.number().int().nonnegative().optional(),
});

export type RawLoopGuard = z.infer<typeof LoopGuardObjectSchema>;

export const PlanModeObjectSchema = z.object({
  force_plan_after_blocks: z.number().int().nonnegative().optional(),
});

export type RawPlanMode = z.infer<typeof PlanModeObjectSchema>;

export const StreamWatchdogObjectSchema = z.object({
  enabled: z.boolean().optional(),
  first_token_ms: z.number().int().positive().optional(),
  no_progress_ms: z.number().int().positive().optional(),
  max_call_ms: z.number().int().positive().optional(),
  repetition_repeats: z.number().int().nonnegative().optional(),
  reasoning_loop_lines: z.number().int().nonnegative().optional(),
  reasoning_cycle_repeats: z.number().int().min(0).max(12).optional(),
});

export type RawStreamWatchdog = z.infer<typeof StreamWatchdogObjectSchema>;

export const VisionObjectSchema = z.object({
  assume_supported: z.boolean().optional(),
  models: z.array(z.string()).optional(),
  max_per_turn: z.number().int().positive().optional(),
  max_bytes_soft: z.number().int().positive().optional(),
  max_bytes_hard: z.number().int().positive().optional(),
});

export type RawVision = z.infer<typeof VisionObjectSchema>;

export const AttachmentsObjectSchema = z.object({
  gc_on_startup: z.boolean().optional(),
  gc_min_age_hours: z.number().positive().optional(),
});

export type RawAttachments = z.infer<typeof AttachmentsObjectSchema>;

export const ResizeObjectSchema = z.object({
  enabled: z.boolean().optional(),
  max_dimension: z.number().int().positive().optional(),
});

export type RawResize = z.infer<typeof ResizeObjectSchema>;

export const MalformedPathObjectSchema = z.object({
  enabled: z.boolean().optional(),
});

export type RawMalformedPath = z.infer<typeof MalformedPathObjectSchema>;

export const BuildGateObjectSchema = z.object({
  enabled: z.boolean().optional(),
  max_attempts: z.number().int().nonnegative().optional(),
  timeout_ms: z.number().int().positive().optional(),
  max_output_lines: z.number().int().positive().optional(),
});

export type RawBuildGate = z.infer<typeof BuildGateObjectSchema>;

export const OrchestrationObjectSchema = z.object({
  enabled: z.boolean().optional(),
  orchestrator_model: z.string().optional(),
  worker_model: z.string().optional(),
  orchestrator_provider: z.string().optional(),
  worker_provider: z.string().optional(),
  max_tasks: z.number().int().positive().optional(),
  max_replans: z.number().int().positive().optional(),
  max_task_retries: z.number().int().nonnegative().optional(),
  max_task_attempts: z.number().int().positive().optional(),
  max_scope_growth: z.number().min(1).optional(),
  worker_turn_tokens: z.number().int().nonnegative().optional(),
  worker_progress_extension_tokens: z.number().int().nonnegative().optional(),
  worker_max_token_multiplier: z.number().min(1).optional(),
  worker_no_progress_tokens: z.number().int().nonnegative().optional(),
  worker_turn_ms: z.number().int().nonnegative().optional(),
  worker_thrash_repeats: z.number().int().nonnegative().optional(),
  protect_existing_files: z.boolean().optional(),
  guard_pending_scope: z.boolean().optional(),
  recovery_escalation: z.boolean().optional(),
  final_integration: z.boolean().optional(),
});

export type RawOrchestration = z.infer<typeof OrchestrationObjectSchema>;

export const ContextObjectSchema = z
  .object({
    budget_tokens: z.number().int().positive().optional(),
    max_budget_tokens: z.number().int().positive().optional(),
    response_reserve_tokens: z.number().int().nonnegative().optional(), // 0 = no reserve
    summarize: z.boolean().optional(),
    trim_high_water: z.number().gt(0).lt(1).optional(),
    trim_low_water: z.number().gt(0).lt(1).optional(),
    max_summary_input_tokens: z.number().int().positive().optional(),
    summary_timeout_ms: z.number().int().positive().optional(),
    max_deep_tool_result_chars: z.number().int().positive().optional(),
    max_live_tool_result_chars: z.number().int().positive().optional(),
    warn_tokens: z.number().int().positive().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.trim_high_water !== undefined &&
      v.trim_low_water !== undefined &&
      v.trim_low_water >= v.trim_high_water
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "context.trim_low_water must be less than trim_high_water",
      });
    }
  });

export type RawContext = z.infer<typeof ContextObjectSchema>;

const ColorStr = z.string();
const SyntaxColorsSchema = z
  .object({
    keyword: ColorStr.optional(),
    string: ColorStr.optional(),
    comment: ColorStr.optional(),
    number: ColorStr.optional(),
    function: ColorStr.optional(),
    attr: ColorStr.optional(),
  })
  .optional();

export const UiObjectSchema = z.object({
  theme: z.enum(["dark", "light"]).optional(),
  colors: z
    .object({
      code: ColorStr.optional(),
      heading: ColorStr.optional(),
      rule: ColorStr.optional(),
      dim: ColorStr.optional(),
      user_input: ColorStr.optional(),
      tool_line: ColorStr.optional(),
      success: ColorStr.optional(),
      error: ColorStr.optional(),
      warning: ColorStr.optional(),
      accent: ColorStr.optional(),
      accent_alt: ColorStr.optional(),
      table_border: ColorStr.optional(),
      syntax: SyntaxColorsSchema,
    })
    .optional(),
});

export type RawUi = z.infer<typeof UiObjectSchema>;

export const RawConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  mcp_servers: z.record(z.string(), McpServerConfigSchema).default({}),
  embeddings: EmbeddingsConfigSchema,
  default_provider: z.string().optional(),
  default_model: z.string().optional(),
  global_workspace_dir: z.string().optional(),
  permissions_disabled: z.boolean().optional(),
  max_tool_loops: z.number().int().nonnegative().optional(),
  default_persona: z.enum(["coding", "chat", "concise", "general"]).optional(),
  default_effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  default_personality: z.enum(["neutral", "cleetus", "bofh"]).optional(),
  personality_correction: z.boolean().optional(),
  system_prompt_file: z.string().optional(),
  structured_output: z.enum(["auto", "off"]).optional(),
  capability: z.enum(["small", "standard", "auto"]).optional(),
  model_profiles: z
    .record(
      z.string(),
      z.record(
        z.string(),
        z.object({
          capability: z.enum(["small", "standard", "auto"]).optional(),
          max_budget_tokens: z.number().int().min(4096).optional(),
        }),
      ),
    )
    .optional(),
  routing: RoutingObjectSchema.optional(),
  sandbox: SandboxObjectSchema.optional(),
  web_tools: WebToolsObjectSchema.optional(),
  repo_map: RepoMapObjectSchema.optional(),
  streaming: StreamingObjectSchema.optional(),
  skills: SkillsObjectSchema.optional(),
  specs: SpecsObjectSchema.optional(),
  subagents: SubagentsObjectSchema.optional(),
  package_manager: PackageManagerObjectSchema.optional(),
  hooks: HooksSchema.optional(),
  model_family: ModelFamilyObjectSchema.optional(),
  plan_or_go: PlanOrGoObjectSchema.optional(),
  diagnostics: DiagnosticsObjectSchema.optional(),
  format: FormatObjectSchema.optional(),
  test: TestObjectSchema.optional(),
  smoke_run: SmokeRunObjectSchema.optional(),
  build_gate: BuildGateObjectSchema.optional(),
  checkpoint: CheckpointObjectSchema.optional(),
  loop_guard: LoopGuardObjectSchema.optional(),
  plan_mode: PlanModeObjectSchema.optional(),
  stream_watchdog: StreamWatchdogObjectSchema.optional(),
  vision: VisionObjectSchema.optional(),
  attachments: AttachmentsObjectSchema.optional(),
  resize: ResizeObjectSchema.optional(),
  malformed_path: MalformedPathObjectSchema.optional(),
  orchestration: OrchestrationObjectSchema.optional(),
  context: ContextObjectSchema.optional(),
  ui: UiObjectSchema.optional(),
});

export type RawConfig = z.infer<typeof RawConfigSchema>;
