import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { stringify } from "yaml";
import { resolveConfigRoot } from "../../config/config-root";
import { loadConfig } from "../../config/loader";
import { buildProvider } from "../../providers/factory";
import { ProviderRegistry } from "../../providers/registry";
import { createSandbox } from "../../sandbox/factory";
import type { Sandbox } from "../../sandbox/types";
import { WorkflowDraftStore } from "../../workflows/creator/draft-store";
import type { WorkflowDryRun } from "../../workflows/dry-run";
import type { WorkflowEventSink } from "../../workflows/events";
import { WorkflowDraftExecutionGuard } from "../../workflows/execution-guard";
import {
  formatWorkflowDryRun,
  formatWorkflowHistory,
  formatWorkflowResult,
  formatWorkflowRunDetail,
} from "../../workflows/format";
import { WorkflowGrantStore } from "../../workflows/grants";
import { WorkflowRunStore } from "../../workflows/journal";
import {
  type ManualWorkflowReview,
  beginManualWorkflowRevision,
  discardManualWorkflowDraft,
  publishManualWorkflowDraft,
  reviewManualWorkflowDraft,
  staleManualWorkflowGuidance,
} from "../../workflows/manual-authoring";
import { WorkflowModelCallService } from "../../workflows/model-call";
import { type WorkflowPackage, loadWorkflowPackage } from "../../workflows/package";
import type { WorkflowExecutionPlan } from "../../workflows/plan";
import { WorkflowRegistry } from "../../workflows/registry";
import { workflowRunDbPath } from "../../workflows/run-paths";
import { scaffoldWorkflowPackage } from "../../workflows/scaffold";
import { WorkflowSchemaService } from "../../workflows/schema";
import {
  type WorkflowAuthorizationDecision,
  WorkflowService,
  WorkflowServiceError,
} from "../../workflows/service";
import { createBuiltinWorkflowStepRegistry } from "../../workflows/steps";
import type { JsonObject, JsonValue } from "../../workflows/types";
import { validateWorkflowPackage } from "../../workflows/validate";

export interface WorkflowCliIo {
  write(value: string): void;
  writeErr(value: string): void;
}

export interface WorkflowAuthorizationRequest {
  plan: WorkflowExecutionPlan;
  dryRun: WorkflowDryRun;
}

export type RequestWorkflowAuthorization = (
  request: WorkflowAuthorizationRequest,
) => Promise<WorkflowAuthorizationDecision>;

function workflowRoot(scope: "project" | "global", projectDir: string, configDir: string): string {
  return scope === "project"
    ? join(projectDir, ".cleetus", "workflows")
    : join(configDir, "workflows");
}

function manualDraftLocation(input: {
  name: string;
  global?: boolean;
  projectDir: string;
  configDir: string;
}): { scope: "project" | "global"; root: string } {
  if (input.global) {
    return {
      scope: "global",
      root: workflowRoot("global", input.projectDir, input.configDir),
    };
  }
  const projectRoot = workflowRoot("project", input.projectDir, input.configDir);
  if (existsSync(join(projectRoot, ".manual-drafts", input.name, "draft.json"))) {
    return { scope: "project", root: projectRoot };
  }
  const globalRoot = workflowRoot("global", input.projectDir, input.configDir);
  if (existsSync(join(globalRoot, ".manual-drafts", input.name, "draft.json"))) {
    return { scope: "global", root: globalRoot };
  }
  return { scope: "project", root: projectRoot };
}

export function formatManualWorkflowReview(review: ManualWorkflowReview): string {
  const validationIssues = review.validation.issues.slice(0, 20);
  const failedTests = review.tests.filter((test) => !test.passed);
  const shownTests = failedTests.slice(0, 20);
  const changes = review.semanticDiff.changes.slice(0, 40);
  const authorityAdded = review.semanticDiff.authority.added.slice(0, 30);
  const authorityRemoved = review.semanticDiff.authority.removed.slice(0, 30);
  const lines = [
    `Manual workflow draft: ${review.candidate.name} revision ${review.targetRevision}`,
    `Scope: ${review.draft.record.scope}`,
    `Draft: ${review.draft.packageDir}`,
    `Base revision: ${review.draft.record.base.revision}`,
    `Base status: ${review.stale ? "stale" : "current"}`,
    `Validation: ${review.validation.plan ? "passed" : "failed"}`,
  ];
  if (validationIssues.length > 0) {
    lines.push(...validationIssues.map((issue) => `  ${issue.path}: ${issue.message}`));
    if (review.validation.issues.length > validationIssues.length) {
      lines.push(`  … ${review.validation.issues.length - validationIssues.length} more issues`);
    }
  }
  lines.push(
    `Tests: ${
      review.tests.length === 0
        ? "none"
        : `${review.tests.filter((result) => result.passed).length}/${review.tests.length} passed`
    }`,
  );
  for (const result of shownTests) {
    lines.push(`  ${result.name}: ${result.failures.join("; ")}`);
  }
  if (failedTests.length > shownTests.length) {
    lines.push(`  … ${failedTests.length - shownTests.length} more failed tests`);
  }
  lines.push("Semantic diff:");
  if (changes.length === 0) {
    lines.push("  none");
  } else {
    lines.push(
      ...changes.map(
        (change) =>
          `  ${change.category}: ${change.path} — ${change.before ?? "(added)"} → ${change.after ?? "(removed)"}`,
      ),
    );
    if (review.semanticDiff.changes.length > changes.length) {
      lines.push(`  … ${review.semanticDiff.changes.length - changes.length} more changes`);
    }
  }
  lines.push(
    `Authority added: ${authorityAdded.join(", ") || "none"}${
      review.semanticDiff.authority.added.length > authorityAdded.length
        ? `, … ${review.semanticDiff.authority.added.length - authorityAdded.length} more`
        : ""
    }`,
    `Authority removed: ${authorityRemoved.join(", ") || "none"}${
      review.semanticDiff.authority.removed.length > authorityRemoved.length
        ? `, … ${review.semanticDiff.authority.removed.length - authorityRemoved.length} more`
        : ""
    }`,
    `Risk flags: ${review.semanticDiff.riskFlags.join(", ") || "none"}`,
    "",
    review.stale
      ? staleManualWorkflowGuidance(review.candidate.name)
      : !review.validation.plan
        ? "Publishing is blocked until validation passes."
        : failedTests.length > 0
          ? "Publishing is blocked until all packaged tests pass."
          : !review.changed
            ? "Publishing is blocked because the draft has no publishable changes."
            : `Ready to publish with /workflow publish ${review.candidate.name} in Cleetus or cleetus workflow publish ${review.candidate.name} in a shell.`,
  );
  return `${lines.join("\n")}\n`;
}

const unavailableSandbox: Sandbox = {
  async exec() {
    throw new Error("workflow execution dependencies were not initialized");
  },
  async dispose() {},
  writeRoot: () => null,
};

function parseScalar(value: string): JsonValue {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return Number(value);
  if (/^[\[{"]/u.test(value)) {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      throw new Error(`ambiguous JSON-like input '${value}' is not valid JSON`);
    }
  }
  return value;
}

export function parseWorkflowCliInputs(pairs: string[], jsonPath?: string): JsonObject {
  let inputs: JsonObject = {};
  if (jsonPath) {
    const parsed = JSON.parse(readFileSync(resolve(jsonPath), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--inputs-json must contain one JSON object");
    }
    inputs = parsed as JsonObject;
  }
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) throw new Error(`invalid --input '${pair}'; expected key=value`);
    const key = pair.slice(0, index);
    if (Object.hasOwn(inputs, key)) throw new Error(`duplicate workflow input '${key}'`);
    inputs[key] = parseScalar(pair.slice(index + 1));
  }
  return inputs;
}

export async function buildWorkflowService(input: {
  projectDir: string;
  configDir: string;
  execution: boolean;
  runtime?: {
    sandbox: Sandbox;
    providers: ProviderRegistry;
    defaultProvider?: string;
    defaultModel?: string;
  };
  /** Interactive hosts may supply a consolidated authorization prompt. The CLI omits it and
   * therefore remains strictly noninteractive. */
  requestAuthorization?: RequestWorkflowAuthorization;
  /** Optional lifecycle mirror used by interactive hosts for progress presentation. */
  events?: WorkflowEventSink;
}): Promise<{
  service: WorkflowService;
  registry: WorkflowRegistry;
  stepRegistry(
    pkg: WorkflowPackage,
    store?: WorkflowRunStore,
  ): ReturnType<typeof createBuiltinWorkflowStepRegistry>;
  dispose(): Promise<void>;
}> {
  const registry = new WorkflowRegistry({
    projectDir: input.projectDir,
    globalDir: input.configDir,
  });
  const schemas = new WorkflowSchemaService();
  let sandbox: Sandbox = unavailableSandbox;
  const providers = new ProviderRegistry();
  let defaultProvider: string | undefined;
  let defaultModel: string | undefined;
  let ownsSandbox = false;
  if (input.runtime) {
    sandbox = input.runtime.sandbox;
    for (const name of input.runtime.providers.names()) {
      providers.register(name, input.runtime.providers.get(name));
    }
    defaultProvider = input.runtime.defaultProvider;
    defaultModel = input.runtime.defaultModel;
  } else if (input.execution) {
    const config = await loadConfig({
      globalPath: join(input.configDir, "config.yaml"),
      projectDir: input.projectDir,
    });
    for (const [name, provider] of Object.entries(config.providers)) {
      providers.register(name, buildProvider(provider.type, provider.baseUrl, provider.apiKey));
    }
    defaultProvider = config.defaultProvider ?? providers.names()[0];
    defaultModel = config.defaultModel;
    sandbox = await createSandbox(config.sandbox, input.projectDir);
    ownsSandbox = true;
  }
  const modelCalls = new WorkflowModelCallService((name) => providers.get(name));
  const grants = new WorkflowGrantStore(
    join(input.projectDir, ".cleetus", "workflow-grants.yaml"),
    join(input.configDir, "workflow-grants.yaml"),
  );
  const stepRegistry = (pkg: WorkflowPackage, store?: WorkflowRunStore) =>
    createBuiltinWorkflowStepRegistry({
      schemas,
      sandbox,
      modelCalls,
      packageDir: pkg.dir,
      workflowModel: {
        provider: pkg.manifest.execution.model?.provider,
        model: pkg.manifest.execution.model?.name,
      },
      defaultModel: { provider: defaultProvider, model: defaultModel },
      journal: store,
      allowSensitiveInput(stepId, origins) {
        return origins
          .filter((origin) => origin.startsWith("secret:"))
          .every((origin) =>
            pkg.manifest.secrets?.[origin.slice("secret:".length)]?.expose_to_llm?.includes(stepId),
          );
      },
    });
  const service = new WorkflowService({
    registry,
    workspace: input.projectDir,
    openStore: () =>
      new WorkflowRunStore(
        workflowRunDbPath({ projectDir: input.projectDir, configDir: input.configDir }),
      ),
    stepRegistry,
    events: input.events,
    executionGuard: new WorkflowDraftExecutionGuard(
      new WorkflowDraftStore(join(input.projectDir, ".cleetus", "workflows")),
    ),
    async authorize(plan, dryRun) {
      const grant = grants.lookup({
        workflow: plan.package.name,
        executionHash: plan.package.executionHash,
        permissions: plan.permissions,
      });
      if (grant.decision === "deny") return "deny";
      if (grant.decision === "allow") return "trust_revision";
      if (input.requestAuthorization) {
        const decision = await input.requestAuthorization({ plan, dryRun });
        if (decision === "trust_revision") {
          grants.persist("project", {
            workflow: plan.package.name,
            executionHash: plan.package.executionHash,
            permissions: plan.permissions,
            decision: "allow",
          });
        }
        return decision;
      }
      throw new WorkflowServiceError(
        "missing_grant",
        `no exact-revision grant for '${plan.package.name}' (${plan.package.executionHash})`,
      );
    },
  });
  return {
    service,
    registry,
    stepRegistry,
    async dispose() {
      if (ownsSandbox) await sandbox.dispose();
    },
  };
}

export async function runWorkflowCli(
  argv: string[],
  cwd: string,
  io: WorkflowCliIo,
): Promise<number> {
  const index = argv.indexOf("workflow");
  const rest = index >= 0 ? argv.slice(index + 1) : argv;
  const program = new Command();
  program
    .name("cleetus workflow")
    .option("--project-dir <path>")
    .option("--config-dir <path>")
    .option("--json");
  program
    .command("init <name>")
    .description("create a valid workflow package skeleton")
    .option("--global", "create the workflow in the global Cleetus config directory")
    .option("--description <text>", "initial workflow description");
  program
    .command("revise <name>")
    .description("create an isolated manual revision of an active workflow")
    .option("--global", "revise the global workflow even if a project workflow shadows it");
  program
    .command("review <name>")
    .description("validate, test, and compare an isolated manual revision")
    .option("--global", "review the global manual draft");
  program
    .command("publish <name>")
    .description("publish a reviewed manual revision without running it")
    .option("--global", "publish the global manual draft");
  program
    .command("discard <name>")
    .description("discard an isolated manual revision")
    .option("--global", "discard the global manual draft");
  program.command("list");
  program.command("show <name>");
  program.command("validate <name>");
  program
    .command("dry-run <name>")
    .option(
      "--input <key=value>",
      "workflow input",
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option("--inputs-json <path>");
  program
    .command("run <name>")
    .option(
      "--input <key=value>",
      "workflow input",
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option("--inputs-json <path>");
  program
    .command("history [name] [run-id]")
    .option("--limit <n>", "page size", "20")
    .option("--offset <n>", "page offset", "0");
  program.command("test <name>");
  program.exitOverride();
  try {
    program.parse(rest, { from: "user" });
  } catch (error) {
    return (error as { exitCode?: number }).exitCode ?? 2;
  }
  const command = program.args[0];
  if (!command) {
    program.outputHelp();
    return 0;
  }
  const root = program.opts<{ projectDir?: string; configDir?: string; json?: boolean }>();
  const projectDir = resolve(cwd, root.projectDir ?? ".");
  const configDir = resolveConfigRoot(root.configDir, homedir(), cwd);
  const execution = command === "run";
  const built = await buildWorkflowService({ projectDir, configDir, execution });
  try {
    const subcommand = program.commands.find((candidate) => candidate.name() === command)!;
    const options = subcommand.opts<{
      input?: string[];
      inputsJson?: string;
      limit?: string;
      offset?: string;
      global?: boolean;
      description?: string;
    }>();
    const args = subcommand.args;
    if (command === "init") {
      const scope = options.global ? "global" : "project";
      const result = scaffoldWorkflowPackage({
        name: args[0]!,
        description: options.description,
        root:
          scope === "global"
            ? join(configDir, "workflows")
            : join(projectDir, ".cleetus", "workflows"),
        scope,
      });
      const pkg = loadWorkflowPackage(result.dir, result.scope);
      const validation = validateWorkflowPackage(pkg, built.stepRegistry(pkg));
      if (!validation.plan) {
        throw new WorkflowServiceError(
          "invalid_package",
          validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
        );
      }
      if (root.json) {
        io.write(`${JSON.stringify(result)}\n`);
      } else {
        io.write(
          [
            `Created ${result.scope} workflow skeleton '${result.name}'.`,
            `Path: ${result.dir}`,
            "",
            "Next:",
            `  cleetus workflow validate ${result.name}`,
            `  cleetus workflow test ${result.name}`,
            `  cleetus workflow dry-run ${result.name}`,
            "",
          ].join("\n"),
        );
      }
      return 0;
    }
    if (command === "revise") {
      const name = args[0]!;
      const active = options.global
        ? loadWorkflowPackage(join(workflowRoot("global", projectDir, configDir), name), "global")
        : built.service.show(name);
      const rootPath = workflowRoot(active.source, projectDir, configDir);
      const draft = beginManualWorkflowRevision({ active, root: rootPath });
      if (root.json) {
        io.write(
          `${JSON.stringify({
            name: draft.record.name,
            scope: draft.record.scope,
            base_revision: draft.record.base.revision,
            draft_dir: draft.packageDir,
          })}\n`,
        );
      } else {
        io.write(
          [
            `Created an isolated manual revision for '${name}'.`,
            `Draft: ${draft.packageDir}`,
            `Base: ${draft.record.scope} revision ${draft.record.base.revision}`,
            "",
            "Edit files in the draft directory, then run:",
            `  cleetus workflow review ${name}${draft.record.scope === "global" ? " --global" : ""}`,
            "",
            "The active workflow has not changed and the draft cannot be run.",
            "",
          ].join("\n"),
        );
      }
      return 0;
    }
    if (command === "review") {
      const name = args[0]!;
      const location = manualDraftLocation({
        name,
        global: options.global,
        projectDir,
        configDir,
      });
      const review = await reviewManualWorkflowDraft({
        ...location,
        name,
        steps: (pkg) => built.stepRegistry(pkg),
      });
      if (root.json) {
        io.write(
          `${JSON.stringify({
            name,
            scope: location.scope,
            draft_dir: review.draft.packageDir,
            base_revision: review.draft.record.base.revision,
            target_revision: review.targetRevision,
            stale: review.stale,
            valid: Boolean(review.validation.plan),
            issues: review.validation.issues,
            tests: review.tests,
            changed: review.changed,
            semantic_diff: review.semanticDiff,
          })}\n`,
        );
      } else {
        io.write(formatManualWorkflowReview(review));
      }
      return !review.stale &&
        review.validation.plan &&
        review.tests.every((result) => result.passed) &&
        review.changed
        ? 0
        : 3;
    }
    if (command === "publish") {
      const name = args[0]!;
      const location = manualDraftLocation({
        name,
        global: options.global,
        projectDir,
        configDir,
      });
      const result = await publishManualWorkflowDraft({
        ...location,
        name,
        steps: (pkg) => built.stepRegistry(pkg),
        registry: built.registry,
      });
      if (root.json) {
        io.write(
          `${JSON.stringify({
            name,
            scope: location.scope,
            revision: result.revision,
            active_dir: result.activeDir,
            archived_dir: result.backupDir,
          })}\n`,
        );
      } else {
        io.write(
          `${[
            `Published ${location.scope} workflow '${name}' revision ${result.revision}.`,
            `Active: ${result.activeDir}`,
            result.backupDir ? `Archived previous revision: ${result.backupDir}` : "",
            "The workflow was not run.",
            "",
          ]
            .filter((line) => line !== "")
            .join("\n")}\n`,
        );
      }
      return 0;
    }
    if (command === "discard") {
      const name = args[0]!;
      const location = manualDraftLocation({
        name,
        global: options.global,
        projectDir,
        configDir,
      });
      discardManualWorkflowDraft({ ...location, name });
      io.write(
        root.json
          ? `${JSON.stringify({ name, scope: location.scope, discarded: true })}\n`
          : `Discarded the ${location.scope} manual draft for '${name}'. The active workflow was not changed.\n`,
      );
      return 0;
    }
    if (command === "list") {
      const list = built.service.list();
      io.write(
        root.json
          ? `${JSON.stringify(
              list.map((pkg) => ({
                name: pkg.name,
                description: pkg.description,
                source: pkg.source,
                revision: pkg.manifest.revision,
                execution_hash: pkg.executionHash,
              })),
            )}\n`
          : `${list.map((pkg) => `${pkg.name}\t${pkg.source}\t${pkg.description}`).join("\n")}\n`,
      );
      return 0;
    }
    if (command === "show") {
      const pkg = built.service.show(args[0]!);
      io.write(root.json ? `${JSON.stringify(pkg.manifest)}\n` : stringify(pkg.manifest));
      return 0;
    }
    if (command === "validate") {
      const result = built.service.validate(args[0]!);
      if (root.json) io.write(`${JSON.stringify(result.issues)}\n`);
      else
        io.write(
          result.issues.length
            ? `${result.issues.map((v) => `${v.path}: ${v.message}`).join("\n")}\n`
            : "valid\n",
        );
      return result.issues.length ? 3 : 0;
    }
    if (command === "test") {
      const results = await built.service.test(args[0]!);
      if (root.json) io.write(`${JSON.stringify(results)}\n`);
      else if (results.length === 0) io.write("no workflow tests found\n");
      else {
        io.write(
          `${results
            .map((result) =>
              result.passed
                ? `✓ ${result.name}`
                : `✗ ${result.name}: ${result.failures.join("; ")}`,
            )
            .join("\n")}\n`,
        );
      }
      return results.every((result) => result.passed) ? 0 : 6;
    }
    if (command === "dry-run") {
      const value = built.service.dryRun(
        args[0]!,
        parseWorkflowCliInputs(options.input ?? [], options.inputsJson),
      );
      io.write(root.json ? `${JSON.stringify(value)}\n` : `${formatWorkflowDryRun(value)}\n`);
      return 0;
    }
    if (command === "history") {
      const requestedRun = args[1];
      if (requestedRun) {
        const runId =
          requestedRun === "latest"
            ? built.service.history({ workflowName: args[0], limit: 1, offset: 0 })[0]?.id
            : requestedRun;
        if (!runId) {
          throw new WorkflowServiceError(
            "not_found",
            `no workflow runs were found for '${args[0]}'`,
          );
        }
        const detail = built.service.runDetail(args[0]!, runId);
        io.write(
          root.json ? `${JSON.stringify(detail)}\n` : `${formatWorkflowRunDetail(detail)}\n`,
        );
        return 0;
      }
      const records = built.service.history({
        workflowName: args[0],
        limit: Number(options.limit),
        offset: Number(options.offset),
      });
      io.write(root.json ? `${JSON.stringify(records)}\n` : `${formatWorkflowHistory(records)}\n`);
      return 0;
    }
    built.service.assertRunnable(args[0]!);
    const result = await built.service.run({
      name: args[0]!,
      inputs: parseWorkflowCliInputs(options.input ?? [], options.inputsJson),
    });
    const pkg = built.service.show(args[0]!);
    io.write(
      root.json
        ? `${JSON.stringify(result)}\n`
        : `${formatWorkflowResult(result, pkg.manifest.presentation?.output)}\n`,
    );
    return result.status === "succeeded" ? 0 : result.status === "cancelled" ? 130 : 5;
  } catch (error) {
    const serviceError = error as WorkflowServiceError;
    io.writeErr(`${serviceError.message}\n`);
    return (
      {
        not_found: 2,
        invalid_package: 3,
        invalid_input: 3,
        missing_secret: 4,
        missing_grant: 4,
        replacement_pending: 4,
        denied: 4,
        failed: 5,
        cancelled: 130,
      }[serviceError.code] ?? 1
    );
  } finally {
    await built.dispose();
  }
}
