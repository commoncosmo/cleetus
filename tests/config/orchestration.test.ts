import { expect, test } from "bun:test";
import { DEFAULT_ORCHESTRATION, resolveOrchestration } from "../../src/config/orchestration";
import { OrchestrationObjectSchema } from "../../src/config/schema";

test("defaults when nothing configured", () => {
  expect(resolveOrchestration(undefined, undefined)).toEqual(DEFAULT_ORCHESTRATION);
});

test("default is disabled with empty model/provider overrides", () => {
  expect(DEFAULT_ORCHESTRATION.enabled).toBe(false);
  expect(DEFAULT_ORCHESTRATION.orchestratorModel).toBe("");
  expect(DEFAULT_ORCHESTRATION.workerModel).toBe("");
  expect(DEFAULT_ORCHESTRATION.orchestratorProvider).toBe("");
  expect(DEFAULT_ORCHESTRATION.workerProvider).toBe("");
  expect(DEFAULT_ORCHESTRATION.maxTasks).toBe(20);
  expect(DEFAULT_ORCHESTRATION.maxReplans).toBe(40);
  expect(DEFAULT_ORCHESTRATION.maxTaskRetries).toBe(1);
  expect(DEFAULT_ORCHESTRATION.maxTaskAttempts).toBe(2);
  expect(DEFAULT_ORCHESTRATION.maxScopeGrowth).toBe(2);
  expect(DEFAULT_ORCHESTRATION.recoveryEscalation).toBe(true);
  expect(DEFAULT_ORCHESTRATION.finalIntegration).toBe(true);
});

test("project overrides global overrides default", () => {
  const r = resolveOrchestration(
    { enabled: true, worker_model: "qwen", max_tasks: 5 },
    { orchestrator_model: "gpt-oss-120b", max_tasks: 9 },
  );
  expect(r.enabled).toBe(true);
  expect(r.orchestratorModel).toBe("gpt-oss-120b"); // project (2nd arg) wins
  expect(r.workerModel).toBe("qwen"); // only global (1st arg) set it
  expect(r.maxTasks).toBe(9); // project wins
  expect(r.maxReplans).toBe(DEFAULT_ORCHESTRATION.maxReplans); // neither arg set it → default
  expect(r.maxTaskRetries).toBe(DEFAULT_ORCHESTRATION.maxTaskRetries); // neither arg set it → default
  expect(r.maxTaskAttempts).toBe(DEFAULT_ORCHESTRATION.maxTaskAttempts);
});

test("provider overrides resolve with project > global > default precedence", () => {
  const r = resolveOrchestration(
    { orchestrator_provider: "openai", worker_provider: "ollama" },
    { worker_provider: "lmstudio" },
  );
  expect(r.orchestratorProvider).toBe("openai"); // only global (1st arg) set it
  expect(r.workerProvider).toBe("lmstudio"); // project (2nd arg) wins
});

test("provider overrides default to empty when unset", () => {
  const r = resolveOrchestration({ orchestrator_model: "gpt-oss-120b" }, undefined);
  expect(r.orchestratorProvider).toBe(""); // → active provider at the call site
  expect(r.workerProvider).toBe("");
});

test("schema accepts provider override strings", () => {
  expect(
    OrchestrationObjectSchema.safeParse({
      orchestrator_provider: "openai",
      worker_provider: "ollama",
    }).success,
  ).toBe(true);
});

test("schema rejects non-positive bounds; allows 0 retries", () => {
  expect(OrchestrationObjectSchema.safeParse({ max_tasks: 0 }).success).toBe(false);
  expect(OrchestrationObjectSchema.safeParse({ max_replans: -1 }).success).toBe(false);
  expect(OrchestrationObjectSchema.safeParse({ max_task_retries: -1 }).success).toBe(false);
  expect(OrchestrationObjectSchema.safeParse({ max_task_retries: 0 }).success).toBe(true); // nonnegative
  expect(OrchestrationObjectSchema.safeParse({ max_task_attempts: 0 }).success).toBe(false);
  expect(OrchestrationObjectSchema.safeParse({ max_task_attempts: 3 }).success).toBe(true);
});

test("max_task_attempts resolves with project over global precedence", () => {
  expect(resolveOrchestration({ max_task_attempts: 3 }).maxTaskAttempts).toBe(3);
  expect(
    resolveOrchestration({ max_task_attempts: 3 }, { max_task_attempts: 4 }).maxTaskAttempts,
  ).toBe(4);
});

test("resolves max_scope_growth with project-over-global precedence", () => {
  expect(resolveOrchestration(undefined, { max_scope_growth: 1.5 }).maxScopeGrowth).toBe(1.5);
  expect(
    resolveOrchestration({ max_scope_growth: 1.5 }, { max_scope_growth: 3 }).maxScopeGrowth,
  ).toBe(3);
});

test("worker_turn_tokens: default, then project > global precedence", () => {
  expect(resolveOrchestration(undefined, undefined).workerTurnTokens).toBe(400000);
  expect(DEFAULT_ORCHESTRATION.workerTurnTokens).toBe(400000);
  expect(resolveOrchestration({ worker_turn_tokens: 100 }, undefined).workerTurnTokens).toBe(100);
  expect(
    resolveOrchestration({ worker_turn_tokens: 100 }, { worker_turn_tokens: 200 }).workerTurnTokens,
  ).toBe(200);
  // 0 is a valid sentinel (unlimited) and must survive resolution, not fall through to default.
  expect(resolveOrchestration(undefined, { worker_turn_tokens: 0 }).workerTurnTokens).toBe(0);
});

test("progress-aware worker token extension resolves defaults and project precedence", () => {
  expect(DEFAULT_ORCHESTRATION.workerProgressExtensionTokens).toBe(200000);
  expect(DEFAULT_ORCHESTRATION.workerMaxTokenMultiplier).toBe(1.5);
  expect(
    resolveOrchestration(
      { worker_progress_extension_tokens: 100, worker_max_token_multiplier: 1.25 },
      { worker_progress_extension_tokens: 200, worker_max_token_multiplier: 1.75 },
    ),
  ).toMatchObject({ workerProgressExtensionTokens: 200, workerMaxTokenMultiplier: 1.75 });
});

test("worker_no_progress_tokens defaults to 150000 and 0 disables", () => {
  expect(resolveOrchestration({}, {}).workerNoProgressTokens).toBe(150000);
  expect(resolveOrchestration({ worker_no_progress_tokens: 0 }, {}).workerNoProgressTokens).toBe(0);
  expect(
    resolveOrchestration({ worker_no_progress_tokens: 50000 }, {}).workerNoProgressTokens,
  ).toBe(50000);
});

test("worker_turn_ms: default, then project > global precedence", () => {
  expect(resolveOrchestration(undefined, undefined).workerTurnMs).toBe(750000);
  expect(DEFAULT_ORCHESTRATION.workerTurnMs).toBe(750000);
  expect(resolveOrchestration({ worker_turn_ms: 100 }, undefined).workerTurnMs).toBe(100);
  expect(resolveOrchestration({ worker_turn_ms: 100 }, { worker_turn_ms: 200 }).workerTurnMs).toBe(
    200,
  );
  // 0 is a valid sentinel (unlimited) and must survive resolution, not fall through to default.
  expect(resolveOrchestration(undefined, { worker_turn_ms: 0 }).workerTurnMs).toBe(0);
});

test("worker_thrash_repeats defaults to 4", () => {
  expect(DEFAULT_ORCHESTRATION.workerThrashRepeats).toBe(4);
  expect(resolveOrchestration().workerThrashRepeats).toBe(4);
});

test("worker_thrash_repeats honors project > global > default", () => {
  expect(resolveOrchestration({ worker_thrash_repeats: 6 }).workerThrashRepeats).toBe(6);
  expect(
    resolveOrchestration({ worker_thrash_repeats: 6 }, { worker_thrash_repeats: 2 })
      .workerThrashRepeats,
  ).toBe(2);
  expect(resolveOrchestration({}, { worker_thrash_repeats: 0 }).workerThrashRepeats).toBe(0);
});

test("protectExistingFiles defaults to true", () => {
  expect(DEFAULT_ORCHESTRATION.protectExistingFiles).toBe(true);
  expect(resolveOrchestration(undefined, undefined).protectExistingFiles).toBe(true);
});

test("protectExistingFiles: project > global > default", () => {
  expect(
    resolveOrchestration({ protect_existing_files: true }, { protect_existing_files: false })
      .protectExistingFiles,
  ).toBe(false); // project (2nd arg) wins
  expect(
    resolveOrchestration({ protect_existing_files: false }, undefined).protectExistingFiles,
  ).toBe(false); // global-only honored
});

test("OrchestrationObjectSchema accepts protect_existing_files", () => {
  expect(
    OrchestrationObjectSchema.parse({ protect_existing_files: false }).protect_existing_files,
  ).toBe(false);
});

test("guardPendingScope defaults to true and honors project > global > default", () => {
  expect(DEFAULT_ORCHESTRATION.guardPendingScope).toBe(true);
  expect(resolveOrchestration(undefined, undefined).guardPendingScope).toBe(true);
  // global sets false, project unset → global wins
  expect(resolveOrchestration({ guard_pending_scope: false }, undefined).guardPendingScope).toBe(
    false,
  );
  // project overrides global
  expect(
    resolveOrchestration({ guard_pending_scope: false }, { guard_pending_scope: true })
      .guardPendingScope,
  ).toBe(true);
});

test("schema accepts guard_pending_scope boolean", () => {
  expect(OrchestrationObjectSchema.safeParse({ guard_pending_scope: false }).success).toBe(true);
  expect(OrchestrationObjectSchema.safeParse({ guard_pending_scope: "no" }).success).toBe(false);
});

test("strong recovery and final integration flags honor project precedence", () => {
  const resolved = resolveOrchestration(
    { recovery_escalation: false, final_integration: false },
    { recovery_escalation: true },
  );
  expect(resolved.recoveryEscalation).toBe(true);
  expect(resolved.finalIntegration).toBe(false);
  expect(
    OrchestrationObjectSchema.safeParse({ recovery_escalation: true, final_integration: false })
      .success,
  ).toBe(true);
});
