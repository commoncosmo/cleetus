import type { WorkflowCreatorController } from "./creator/controller";
import { detectWorkflowCreationIntent } from "./creator/intent";
import { resolveWorkflowReviewReply } from "./creator/reply";
import type { WorkflowDraftRecord, WorkflowRevisionBase } from "./creator/types";
import { parseWorkflowDuration } from "./duration";
import type { WorkflowExecutionConflict } from "./execution-guard";
import {
  formatWorkflowDryRun,
  formatWorkflowHistory,
  formatWorkflowResult,
  formatWorkflowRunDetail,
} from "./format";
import type { WorkflowPackage } from "./package";
import type { WorkflowService } from "./service";
import type { JsonObject, JsonSchema, WorkflowSource } from "./types";

const WORKFLOW_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface WorkflowCommandContext {
  print(
    value: string,
    presentation?: {
      format?: "plain" | "markdown";
      kind?: "message" | "result";
      workflow?: string;
      status?: string;
      runId?: string;
    },
  ): void;
  recordInput?(value: string): void;
  signal?: AbortSignal;
  sessionId?: string;
  collectInputs?: (request: {
    workflow: string;
    schema: JsonSchema;
  }) => Promise<JsonObject>;
  openEditor?: (request: { targets: string[] }) => Promise<void>;
}

export interface WorkflowAuthoringHost {
  creator: WorkflowCreatorController;
  activate(draft: WorkflowDraftRecord, replace?: boolean): { activeDir: string };
  record?(
    context: WorkflowCommandContext,
    type: "notice" | "error",
    payload: Record<string, unknown>,
  ): void;
}

export interface WorkflowManualAuthoringHost {
  open(
    name: string,
    scope?: WorkflowSource,
  ): { packageDir: string; created: boolean; scope: WorkflowSource };
  review(name: string, scope?: WorkflowSource): Promise<string>;
  publish(name: string, scope?: WorkflowSource): Promise<string>;
  discard(name: string, scope?: WorkflowSource): string;
}

function splitCommand(value: string): { command: string; rest: string } {
  const trimmed = value.trim();
  const boundary = trimmed.search(/\s/u);
  if (boundary < 0) return { command: trimmed || "list", rest: "" };
  return {
    command: trimmed.slice(0, boundary),
    rest: trimmed.slice(boundary).trim(),
  };
}

const MANUAL_WORKFLOW_CLI_USAGE: Record<string, string> = {
  init: "cleetus workflow init <name> [--global] [--description <text>]",
  revise: "cleetus workflow revise <name> [--global]",
  review: "cleetus workflow review <name> [--global]",
  publish: "cleetus workflow publish <name> [--global]",
  discard: "cleetus workflow discard <name> [--global]",
};

function manualWorkflowCliGuidance(command: string, rest: string): string {
  const requested = rest
    ? `cleetus workflow ${command} ${rest}`
    : MANUAL_WORKFLOW_CLI_USAGE[command];
  return [
    "Manual workflow package commands run from your shell, not at the Cleetus prompt.",
    "Run this in another terminal, or exit Cleetus first:",
    `  ${requested}`,
    "",
    "`/workflow review` and `/workflow discard` without a workflow name manage conversational creator drafts.",
  ].join("\n");
}

export class WorkflowCommandController {
  private readonly drafts = new Map<string, string>();
  private readonly replacements = new Set<string>();

  constructor(
    private readonly service: WorkflowService,
    private readonly authoring?: WorkflowAuthoringHost,
    private readonly manualAuthoring?: WorkflowManualAuthoringHost,
  ) {}

  completionWorkflows(): Array<{ name: string; source: WorkflowSource }> {
    return this.service.list().map((workflow) => ({
      name: workflow.name,
      source: workflow.source,
    }));
  }

  private key(context: WorkflowCommandContext): string {
    return context.sessionId ?? "terminal";
  }

  private renderDraft(draft: WorkflowDraftRecord): string {
    if (draft.phase === "generating") {
      return `Workflow draft '${draft.name ?? draft.id}' is generating. If a previous process stopped during this turn, use /workflow resume.`;
    }
    if (draft.phase === "failed" || draft.phase === "cancelled") {
      return [
        `Workflow draft '${draft.name ?? draft.id}' ${draft.phase}.`,
        draft.lastError ? `Reason: ${draft.lastError}` : "",
        "The draft and attempted message were saved. Use /workflow retry or /workflow discard.",
      ]
        .filter(Boolean)
        .join("\n");
    }
    const lines =
      draft.phase === "questions"
        ? ["Workflow requirements are still incomplete."]
        : draft.diagnostics.length > 0
          ? ["Workflow draft is not activatable yet."]
          : ["Workflow draft is ready for review."];
    if (draft.phase === "questions" && draft.output?.unresolvedQuestions.length) {
      lines.push(
        "",
        "Cleetus needs these decisions before it can prepare an activatable draft:",
        ...draft.output.unresolvedQuestions.map((question) => `- ${question}`),
        "",
        "Reply with the answers in ordinary language. Activation is blocked until these are resolved.",
      );
      if (draft.output.assumptions.length > 0) {
        lines.push(
          "",
          "Tentative assumptions (not yet accepted):",
          ...draft.output.assumptions.map((assumption) => `- ${assumption}`),
        );
      }
    } else if (draft.diagnostics.length) {
      lines.push(
        "",
        "Cleetus could not produce a valid draft after an automatic repair attempt.",
        "Your requirements are saved. Reply 'retry' to try the repair again, describe what you want changed, or use /workflow discard.",
        "",
        "Technical details:",
        ...draft.diagnostics.slice(0, 12).map((issue) => `- ${issue.path}: ${issue.message}`),
      );
    } else if (draft.phase === "draft" && draft.output?.manifest) {
      const manifest = draft.output.manifest;
      const revisionReview =
        draft.revisionProtocol === "change-set-v1" && draft.changeSet && draft.semanticDiff
          ? [
              "",
              `Requested change: ${draft.changeSet.summary}`,
              "Operations:",
              ...draft.changeSet.operations
                .slice(0, 30)
                .map(
                  (operation, index) =>
                    `  ${index + 1}. ${operation.op} (${operation.id}) — ${operation.rationale}`,
                ),
              "Semantic diff:",
              ...draft.semanticDiff.changes
                .slice(0, 40)
                .map(
                  (change) =>
                    `  ${change.category}: ${change.path} — ${change.before ?? "(added)"} → ${change.after ?? "(removed)"}`,
                ),
              `Authority added: ${draft.semanticDiff.authority.added.join(", ") || "none"}`,
              `Authority removed: ${draft.semanticDiff.authority.removed.join(", ") || "none"}`,
              `Risk flags: ${draft.semanticDiff.riskFlags.join(", ") || "none"}`,
            ]
          : draft.targetRevision && draft.targetRevision > 1
            ? [
                "",
                "Revision protocol: legacy full-package revision",
                ...(draft.semanticDiff
                  ? [
                      "Host-computed semantic diff:",
                      ...draft.semanticDiff.changes
                        .slice(0, 40)
                        .map(
                          (change) =>
                            `  ${change.category}: ${change.path} — ${change.before ?? "(added)"} → ${change.after ?? "(removed)"}`,
                        ),
                      `Authority added: ${draft.semanticDiff.authority.added.join(", ") || "none"}`,
                      `Authority removed: ${draft.semanticDiff.authority.removed.join(", ") || "none"}`,
                      `Risk flags: ${draft.semanticDiff.riskFlags.join(", ") || "none"}`,
                    ]
                  : []),
              ]
            : [];
      const network = (manifest.permissions.network ?? []).flatMap((permission) =>
        permission.methods.map((method) => `${method.toUpperCase()} ${permission.host}`),
      );
      const commands = (manifest.permissions.commands ?? []).map((permission) =>
        [permission.program, ...(permission.args_prefix ?? [])].join(" "),
      );
      const filesystem = [
        ...(manifest.permissions.filesystem?.read ?? []).map((path) => `read ${path}`),
        ...(manifest.permissions.filesystem?.write ?? []).map((path) => `write ${path}`),
      ];
      const authority = [
        ...network,
        ...commands.map((command) => `command ${command}`),
        ...filesystem,
        ...(manifest.permissions.model ? ["model calls"] : []),
      ];
      const authoritySummary = draft.output.authority;
      const retries = manifest.steps.flatMap((step) =>
        step.retry && step.retry.attempts > 0
          ? [`${step.id}: ${step.retry.attempts} retries for ${step.retry.when.join(", ")}`]
          : [],
      );
      const secretNames = Object.entries(manifest.secrets ?? {}).map(
        ([name, secret]) => `${name} (${secret.name})`,
      );
      lines.push(
        "",
        `Review: ${manifest.name} revision ${manifest.revision}`,
        `Scope: ${draft.scope}`,
        `Purpose: ${manifest.description}`,
        ...revisionReview,
        `Inputs: ${Object.keys(manifest.inputs.properties ?? {}).join(", ") || "none"}`,
        "Steps:",
        ...manifest.steps
          .slice(0, 20)
          .map((step, index) => `  ${index + 1}. ${step.id} — ${step.uses}`),
        `Outputs: ${Object.keys(manifest.outputs).join(", ")}`,
        `Permissions: ${authority.join(", ") || "none"}`,
        ...(authoritySummary
          ? [
              `Derived permissions: ${authoritySummary.derived.join(", ") || "none"}`,
              `Explicit permissions: ${authoritySummary.explicit.join(", ") || "none"}`,
            ]
          : []),
        `Secrets: ${secretNames.join(", ") || "none"}`,
        `Retries: ${retries.join("; ") || "none"}`,
        ...(draft.output.assumptions.length > 0
          ? ["Assumptions:", ...draft.output.assumptions.map((assumption) => `  - ${assumption}`)]
          : []),
        ...(draft.output.compilerNotes?.length
          ? ["Compiler notes:", ...draft.output.compilerNotes.map((note) => `  - ${note}`)]
          : []),
        "",
        "Reply 'activate' to save this workflow. Activation will not run it.",
      );
    }
    return lines.join("\n");
  }

  private activeDraft(context: WorkflowCommandContext): WorkflowDraftRecord | undefined {
    if (!this.authoring) return undefined;
    const key = this.key(context);
    const activeId = this.drafts.get(key);
    let draft = activeId
      ? this.authoring.creator.get(activeId)
      : this.authoring.creator.latest(context.sessionId);
    if (draft?.name && (draft.targetRevision ?? 1) > 1 && !draft.baseManifest) {
      const revision = this.revisionContext(draft.name);
      const ensureRevisionBase = this.authoring.creator.ensureRevisionBase?.bind(
        this.authoring.creator,
      );
      if (revision && ensureRevisionBase) {
        draft = ensureRevisionBase(draft.id, revision.base.manifest, revision.resources) ?? draft;
      }
    }
    if (draft) this.drafts.set(key, draft.id);
    else this.drafts.delete(key);
    return draft;
  }

  private blockingReplacement(
    context: WorkflowCommandContext,
    workflowName: string,
  ):
    | {
        conflict: WorkflowExecutionConflict;
        draft?: WorkflowDraftRecord;
      }
    | undefined {
    const sharedConflict = this.service.executionConflict?.(workflowName);
    if (sharedConflict) {
      return {
        conflict: sharedConflict,
        draft: this.authoring?.creator.get(sharedConflict.draftId),
      };
    }
    // Compatibility for lightweight hosts and tests that do not install the shared guard.
    const draft = this.activeDraft(context);
    if (
      draft?.name !== workflowName ||
      (draft.targetRevision ?? draft.output?.manifest?.revision ?? 1) <= 1 ||
      draft.phase !== "draft" ||
      draft.diagnostics.length > 0 ||
      !draft.output?.manifest
    ) {
      return undefined;
    }
    return {
      conflict: {
        kind: "replacement_draft",
        draftId: draft.id,
        workflow: workflowName,
        scope: draft.scope,
        activeRevision: (draft.targetRevision ?? draft.output.manifest.revision) - 1,
        pendingRevision: draft.targetRevision ?? draft.output.manifest.revision,
      },
      draft,
    };
  }

  private renderBlockedReplacement(
    conflict: WorkflowExecutionConflict,
    confirmationPending: boolean,
  ): string {
    if (!confirmationPending) {
      return [
        `Workflow '${conflict.workflow}' has valid replacement revision ${conflict.pendingRevision} awaiting review and activation.`,
        "The currently active revision was not run.",
        "Reply 'activate' to continue in the authoring session, or 'cancel' to discard the replacement. Use /workflow review first when returning to that session. Same-name execution remains blocked while this valid draft exists.",
      ].join("\n");
    }
    return [
      `Workflow '${conflict.workflow}' has reviewed replacement revision ${conflict.pendingRevision} awaiting confirmation.`,
      "The currently active revision was not run.",
      "Reply exactly 'replace' to archive the active workflow and activate this revision, or 'cancel' to discard the replacement. Nothing has been changed.",
    ].join("\n");
  }

  private record(
    context: WorkflowCommandContext,
    type: "notice" | "error",
    kind: string,
    draft: WorkflowDraftRecord,
    extra: Record<string, unknown> = {},
  ): void {
    this.authoring?.record?.(context, type, {
      kind,
      draftId: draft.id,
      workflow: draft.name,
      phase: draft.phase,
      ...extra,
    });
  }

  private async updateDraft(
    draft: WorkflowDraftRecord,
    context: WorkflowCommandContext,
    operation: () => Promise<WorkflowDraftRecord>,
  ): Promise<void> {
    try {
      this.record(context, "notice", "workflow_creator_generating", draft, {
        phase: "generating",
      });
      const updated = await operation();
      this.record(context, "notice", "workflow_creator_updated", updated);
      context.print(this.renderDraft(updated), {
        format: "markdown",
        kind: "message",
        workflow: updated.name,
        status: updated.phase,
      });
    } catch (error) {
      const persisted = this.authoring?.creator.get(draft.id) ?? draft;
      this.record(context, "error", "workflow_creator_failed", persisted, {
        message: persisted.lastError ?? (error as Error).message,
      });
      context.print(this.renderDraft(persisted), {
        format: "markdown",
        kind: "message",
        workflow: persisted.name,
        status: persisted.phase,
      });
    }
  }

  private async beginCreation(
    name: string | undefined,
    context: WorkflowCommandContext,
    requestedScope?: "project" | "global",
  ): Promise<void> {
    if (!this.authoring) {
      context.print("workflow creation is unavailable in this host");
      return;
    }
    const revision = name ? this.revisionContext(name) : undefined;
    const scope = requestedScope ?? revision?.base.source ?? "project";
    const initialQuestions = revision
      ? [
          `What would you like to change in \`${name}\`? Its active definition and latest run are already loaded as context.`,
        ]
      : name
        ? [`What should \`${name}\` do, and what should it return or display?`]
        : [
            "What would you like the workflow to be named?",
            "What should the workflow do, and what should it return or display?",
          ];
    const draft = this.authoring.creator.start({
      name,
      scope,
      sessionId: context.sessionId,
      initialQuestions,
      initialMessages: revision ? [{ role: "user", content: revision.message }] : undefined,
      targetRevision: revision?.targetRevision ?? 1,
      baseManifest: revision?.base.manifest,
      baseResources: revision?.resources,
      revisionBase: revision?.revisionBase,
    });
    this.drafts.set(this.key(context), draft.id);
    this.record(context, "notice", "workflow_creator_started", draft);
    this.record(context, "notice", "workflow_creator_updated", draft);
    context.print(this.renderDraft(draft), {
      format: "markdown",
      kind: "message",
      workflow: draft.name,
      status: draft.phase,
    });
  }

  private revisionContext(name: string):
    | {
        base: WorkflowPackage;
        targetRevision: number;
        resources: Array<{ path: string; content: string }>;
        revisionBase: WorkflowRevisionBase;
        message: string;
      }
    | undefined {
    let active: WorkflowPackage;
    try {
      active = this.service.show(name);
    } catch {
      return undefined;
    }

    let latestRun: ReturnType<WorkflowService["history"]>[number] | undefined;
    let latestSteps: ReturnType<WorkflowService["runSteps"]> = [];
    try {
      latestRun = this.service.history({ workflowName: name, limit: 1, offset: 0 })[0];
      if (latestRun) latestSteps = this.service.runSteps(name, latestRun.id);
    } catch {
      // Revision remains useful even when journal history is unavailable.
    }

    const base = active;
    const resources = (active.files ?? [])
      .filter((resource) => /^(?:prompts|scripts|tests)\//u.test(resource.path))
      .map((resource) => ({ path: resource.path, content: resource.content }));
    const baseExplanation = `Use the currently activated revision ${active.manifest.revision} as the immutable base. Archived revisions and run history are diagnostic context only.`;
    const latestRunContext = latestRun
      ? [
          "Latest run:",
          JSON.stringify(
            {
              revision: latestRun.revision,
              status: latestRun.status,
              error: latestRun.error,
            },
            null,
            2,
          ),
          "Latest run steps:",
          JSON.stringify(latestSteps, null, 2),
        ]
      : ["No run history was available. Revise only from the activated definition."];
    const timeoutDiagnoses = latestSteps.flatMap((record) => {
      if (record.status !== "failed") return [];
      const manifestStep = base.manifest.steps.find((step) => step.id === record.stepId);
      if (
        !manifestStep?.timeout ||
        record.startedAt === undefined ||
        record.endedAt === undefined
      ) {
        return [];
      }
      let timeoutMs: number;
      try {
        timeoutMs = parseWorkflowDuration(manifestStep.timeout);
      } catch {
        return [];
      }
      const elapsedMs = record.endedAt - record.startedAt;
      const code =
        record.error &&
        typeof record.error === "object" &&
        !Array.isArray(record.error) &&
        typeof record.error.code === "string"
          ? record.error.code
          : undefined;
      if (code !== "timeout" && !(code === "cancelled" && elapsedMs >= timeoutMs - 250)) return [];
      return [
        `Host timing diagnosis: step '${record.stepId}' was aborted by its declared ${manifestStep.timeout} timeout after ${elapsedMs}ms. Treat this as a timeout, not a user cancellation. Remove an unnecessarily short explicit LLM timeout or increase it, and ensure the workflow timeout leaves enough time for all steps.`,
      ];
    });

    return {
      base,
      targetRevision: active.manifest.revision + 1,
      resources,
      revisionBase: {
        name: active.name,
        scope: active.source,
        revision: active.manifest.revision,
        packageHash: active.packageHash,
        executionHash: active.executionHash,
        manifest: active.manifest,
        resources,
      },
      message: [
        "[Host revision context]",
        `Revise the existing workflow '${name}'; do not design a new workflow from a blank slate.`,
        baseExplanation,
        "Preserve its name, purpose, inputs, endpoints, step graph, outputs, resources, permissions, and secrets unless the user explicitly requests a behavioral change or a recorded failure requires a narrow correction.",
        "Resolve technical execution failures from the supplied definition and run record without asking the user to know workflow DSL fields.",
        "For an llm.generate step, omit provider and model to inherit the active model. Omit max_output_tokens unless the user explicitly requested a hard output cap.",
        "The llm.generate executor has a 2-minute default step timeout. Omit a shorter explicit timeout unless the user requested that deadline, and ensure the workflow timeout is longer than the total permitted step time.",
        "Do not invent placeholder hosts, new inputs, secrets, or unresolved questions for facts already represented below.",
        ...timeoutDiagnoses,
        "",
        "Base manifest:",
        JSON.stringify(base.manifest, null, 2),
        "",
        "Referenced runtime resources:",
        JSON.stringify(resources, null, 2),
        "",
        ...latestRunContext,
        "",
        "Treat this as background context, not as a complete revision request.",
        "Wait for the user's next message to state the desired change. Apply only that requested change.",
        "Run history is diagnostic background, not authorization to alter retries, timeouts, model selection, permissions, or any other behavior. Correct a recorded execution failure only when the user's revision request asks for that correction.",
        "Do not choose between removing behavior, adding a fallback, or expanding authority unless the user requests that choice.",
      ].join("\n"),
    };
  }

  async handleNatural(input: string, context: WorkflowCommandContext): Promise<boolean> {
    if (!this.authoring || input.trim().startsWith("/")) return false;
    const key = this.key(context);
    const active = this.activeDraft(context);
    if (!active) {
      const intent = detectWorkflowCreationIntent(input);
      if (!intent) return false;
      context.recordInput?.(input);
      await this.beginCreation(intent.name, context);
      return true;
    }
    context.recordInput?.(input);
    const draft = active;
    if (draft.diagnostics.length > 0 && /^retry[.!]?$/iu.test(input.trim())) {
      await this.updateDraft(draft, context, () =>
        this.authoring!.creator.retry(draft.id, context.signal),
      );
      return true;
    }
    if (
      (draft.phase === "failed" || draft.phase === "cancelled") &&
      /^retry[.!]?$/iu.test(input.trim())
    ) {
      await this.updateDraft(draft, context, () =>
        this.authoring!.creator.retry(draft.id, context.signal),
      );
      return true;
    }
    if (draft.phase === "draft" && draft.diagnostics.length === 0) {
      if (this.replacements.has(key) && /^replace[.!]?$/iu.test(input.trim())) {
        const activated = this.authoring.activate(draft, true);
        this.authoring.creator.markActivated(draft.id);
        this.replacements.delete(key);
        this.drafts.delete(key);
        this.record(context, "notice", "workflow_creator_activated", draft, { replace: true });
        context.print(
          `Replaced workflow '${draft.name}' at ${activated.activeDir}. It has not been run.`,
        );
        return true;
      }
      const reply = resolveWorkflowReviewReply(input);
      if (reply.kind === "activate") {
        let activated: { activeDir: string };
        try {
          activated = this.authoring.activate(draft);
        } catch (error) {
          if ((error as Error).message.includes("replacement requires explicit approval")) {
            this.replacements.add(key);
            context.print(
              `Workflow '${draft.name}' already exists. Reply exactly 'replace' to archive it and activate the new revision, or 'cancel'. Nothing has been changed.`,
            );
            return true;
          }
          throw error;
        }
        this.drafts.delete(key);
        this.authoring.creator.markActivated(draft.id);
        this.record(context, "notice", "workflow_creator_activated", draft, { replace: false });
        context.print(
          `Activated workflow '${draft.name}' at ${activated.activeDir}. It has not been run.`,
        );
        return true;
      }
      if (reply.kind === "cancel") {
        this.authoring.creator.discard(draft.id);
        this.replacements.delete(key);
        this.drafts.delete(key);
        this.record(context, "notice", "workflow_creator_discarded", draft);
        context.print("Workflow draft discarded. Nothing was activated or run.");
        return true;
      }
      if (reply.kind === "run_after_activation") {
        const conflict = this.service.executionConflict?.(draft.name!) ?? {
          kind: "replacement_draft" as const,
          draftId: draft.id,
          workflow: draft.name!,
          scope: draft.scope,
          activeRevision: (draft.targetRevision ?? draft.output?.manifest?.revision ?? 2) - 1,
          pendingRevision: draft.targetRevision ?? draft.output?.manifest?.revision ?? 2,
        };
        context.print(
          this.replacements.has(key)
            ? this.renderBlockedReplacement(conflict, true)
            : this.renderBlockedReplacement(conflict, false),
        );
        return true;
      }
    }
    await this.updateDraft(draft, context, () =>
      this.authoring!.creator.respond(draft.id, input, context.signal),
    );
    return true;
  }

  async handle(args: string, context: WorkflowCommandContext): Promise<void> {
    const { command, rest } = splitCommand(args);
    if (
      command === "init" ||
      command === "revise" ||
      (!this.manualAuthoring && command === "publish") ||
      (!this.manualAuthoring && (command === "review" || command === "discard") && Boolean(rest))
    ) {
      context.print(manualWorkflowCliGuidance(command, rest));
      return;
    }
    if (
      this.manualAuthoring &&
      Boolean(rest) &&
      (command === "review" || command === "publish" || command === "discard")
    ) {
      const [manualName, ...options] = rest.split(/\s+/u).filter(Boolean);
      const scope = options.includes("--global")
        ? "global"
        : options.includes("--project")
          ? "project"
          : undefined;
      const unknown = options.filter((value) => value !== "--global" && value !== "--project");
      if (unknown.length > 0) {
        throw new Error(`unexpected workflow ${command} argument: ${unknown[0]}`);
      }
      if (options.includes("--global") && options.includes("--project")) {
        throw new Error("choose either --project or --global, not both");
      }
      if (command === "review") {
        context.print(await this.manualAuthoring.review(manualName!, scope));
      } else if (command === "publish") {
        context.print(await this.manualAuthoring.publish(manualName!, scope));
      } else {
        context.print(this.manualAuthoring.discard(manualName!, scope));
      }
      return;
    }
    if (command === "create") {
      const scope = /^--global(?:\s|$)/u.test(rest)
        ? "global"
        : /^--project(?:\s|$)/u.test(rest)
          ? "project"
          : undefined;
      const nameInput = rest.replace(/^--(?:global|project)(?:\s+|$)/u, "").trim();
      const intent = detectWorkflowCreationIntent(
        `/workflow create${nameInput ? ` ${nameInput}` : ""}`,
      );
      if (!intent) {
        context.print("workflow names use lowercase letters, numbers, and single hyphens");
        return;
      }
      await this.beginCreation(intent.name, context, scope);
      return;
    }
    if (command === "status" || command === "review") {
      const draft = this.activeDraft(context);
      context.print(draft ? this.renderDraft(draft) : "No workflow draft is active.");
      return;
    }
    if (command === "retry" || command === "resume") {
      const draft = this.activeDraft(context);
      if (!draft || !this.authoring) {
        context.print("No workflow draft is available to resume.");
        return;
      }
      if (command === "resume" && (draft.phase === "questions" || draft.phase === "draft")) {
        context.print(this.renderDraft(draft));
        return;
      }
      await this.updateDraft(draft, context, () =>
        this.authoring!.creator.retry(draft.id, context.signal),
      );
      return;
    }
    if (command === "discard") {
      const key = this.key(context);
      const draft = this.activeDraft(context);
      if (!draft || !this.authoring) {
        context.print("No workflow draft is active.");
        return;
      }
      this.authoring.creator.discard(draft.id);
      this.replacements.delete(key);
      this.drafts.delete(key);
      context.print("Workflow draft discarded. Nothing was activated or run.");
      return;
    }
    if (command === "list") {
      const workflows = this.service.list();
      context.print(
        workflows.length
          ? workflows.map((item) => `${item.name}\t${item.source}\t${item.description}`).join("\n")
          : "No activated workflows found.",
      );
      return;
    }
    const [name, ...tail] = rest.split(/\s+/u).filter(Boolean);
    if (!name) {
      context.print(
        "usage: /workflow create [--project|--global] [name] | /workflow edit <name> [--project|--global] | /workflow <status|review|retry|resume|discard|publish|list|show|validate|dry-run|run|history|test> [name] [inputs-json|run-id]",
      );
      return;
    }
    if (
      (command === "edit" ||
        command === "review" ||
        command === "publish" ||
        command === "discard") &&
      !WORKFLOW_NAME.test(name)
    ) {
      throw new Error(
        "workflow name must use lowercase letters and numbers separated by single hyphens",
      );
    }
    const scope = tail.includes("--global")
      ? "global"
      : tail.includes("--project")
        ? "project"
        : undefined;
    const unknownOptions = tail.filter((value) => value !== "--global" && value !== "--project");
    if (
      (command === "edit" ||
        command === "review" ||
        command === "publish" ||
        command === "discard") &&
      unknownOptions.length > 0
    ) {
      throw new Error(`unexpected workflow ${command} argument: ${unknownOptions[0]}`);
    }
    if (tail.includes("--global") && tail.includes("--project")) {
      throw new Error("choose either --project or --global, not both");
    }
    if (command === "edit") {
      if (!this.manualAuthoring || !context.openEditor) {
        context.print("workflow editing is unavailable in this host");
        return;
      }
      const opened = this.manualAuthoring.open(name, scope);
      context.print(
        `${opened.created ? "Created" : "Reopening"} isolated ${opened.scope} workflow draft: ${opened.packageDir}`,
      );
      await context.openEditor({ targets: [opened.packageDir] });
      context.print(await this.manualAuthoring.review(name, opened.scope));
      return;
    }
    if (command === "show") {
      context.print(JSON.stringify(this.service.show(name).manifest, null, 2));
      return;
    }
    if (command === "validate") {
      const result = this.service.validate(name);
      context.print(
        result.issues.length
          ? result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")
          : "valid",
      );
      return;
    }
    if (command === "test") {
      const results = await this.service.test(name);
      context.print(
        results.length
          ? results
              .map((result) =>
                result.passed
                  ? `✓ ${result.name}`
                  : `✗ ${result.name}: ${result.failures.join("; ")}`,
              )
              .join("\n")
          : "no workflow tests found",
      );
      return;
    }
    if (command === "dry-run") {
      let inputs: JsonObject = {};
      const encoded = tail.join(" ");
      if (encoded) {
        const parsed = JSON.parse(encoded) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("workflow inputs must be one JSON object");
        }
        inputs = parsed as JsonObject;
      }
      context.print(formatWorkflowDryRun(this.service.dryRun(name, inputs)));
      return;
    }
    if (command === "history") {
      const requestedRun = tail[0];
      if (requestedRun) {
        const runId =
          requestedRun === "latest"
            ? this.service.history({ workflowName: name, limit: 1, offset: 0 })[0]?.id
            : requestedRun;
        if (!runId) {
          context.print(`No workflow runs found for '${name}'.`);
          return;
        }
        context.print(formatWorkflowRunDetail(this.service.runDetail(name, runId)));
        return;
      }
      context.print(
        formatWorkflowHistory(this.service.history({ workflowName: name, limit: 20, offset: 0 })),
      );
      return;
    }
    if (command === "run") {
      const blocking = this.blockingReplacement(context, name);
      if (blocking) {
        const confirmationPending =
          blocking.draft?.id === this.drafts.get(this.key(context)) &&
          this.replacements.has(this.key(context));
        if (blocking.draft) {
          this.record(context, "notice", "workflow_replacement_run_blocked", blocking.draft, {
            pendingRevision: blocking.conflict.pendingRevision,
            stage: confirmationPending ? "replacement_confirmation" : "valid_draft",
          });
        }
        context.print(this.renderBlockedReplacement(blocking.conflict, confirmationPending));
        return;
      }
      this.service.assertRunnable?.(name);
      let inputs: JsonObject = {};
      const encoded = tail.join(" ");
      if (encoded) {
        const parsed = JSON.parse(encoded) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("workflow inputs must be one JSON object");
        }
        inputs = parsed as JsonObject;
      } else if (context.collectInputs) {
        inputs = await context.collectInputs({
          workflow: name,
          schema: this.service.show(name).manifest.inputs,
        });
      }
      const result = await this.service.run({ name, inputs, signal: context.signal });
      const presentationOutput = this.service.show(name).manifest.presentation?.output;
      const selected =
        result.status === "succeeded" && presentationOutput && result.outputs
          ? result.outputs[presentationOutput]
          : undefined;
      const markdown =
        typeof selected === "string" ||
        (Array.isArray(selected) &&
          selected.length > 0 &&
          selected.every((item) => typeof item === "string"));
      context.print(formatWorkflowResult(result, presentationOutput), {
        format: markdown ? "markdown" : "plain",
        kind: "result",
        workflow: name,
        status: result.status,
        runId: result.run_id,
      });
      return;
    }
    context.print(`unknown workflow command '${command}'`);
  }
}
