import { readFile } from "node:fs/promises";
import { ulid } from "ulid";
import type { EventSource } from "../events/log";
import type { EventSink } from "../events/types";
import { diffLines } from "../improve/promote";
import type { ProviderRegistry } from "../providers/registry";
import type { ChatOptions } from "../providers/types";
import type { SkillRegistry } from "../skills/registry";
import { triggeredSkills } from "../skills/trigger";
import type { Skill } from "../skills/types";
import { revisePlaybook, savePlaybook } from "./persist";
import { type PlaybookSynthesisTelemetry, synthesizePlaybook } from "./synthesize";
import { latestLearnableTurn } from "./trajectory";
import type { PlaybookDraft, PlaybookScope } from "./types";

export interface LearnPlaybookController {
  propose(signal?: AbortSignal): Promise<string>;
  save(scope: PlaybookScope): Promise<string>;
  discard(): string;
  status(): string;
}

export interface LearnPlaybookServiceOptions {
  events: EventSource;
  eventSink?: EventSink;
  getSessionId: () => string;
  providers: ProviderRegistry;
  getActive: () => { provider: string; model: string };
  skills: SkillRegistry;
  projectDir: string;
  globalDir: string;
  skillsEnabled: boolean;
  autoInvoke: boolean;
  structuredOutput?: boolean;
  modelFamily?: ChatOptions["modelFamily"];
}

interface RevisionTarget {
  skill: Skill;
  path: string;
  reviewedContent: string;
}

type PendingProposal =
  | { kind: "create"; draft: PlaybookDraft; supportingSkills: string[] }
  | {
      kind: "update";
      draft: PlaybookDraft;
      target: RevisionTarget;
      supportingSkills: string[];
    };

function completeDraft(draft: PlaybookDraft): string {
  return [
    draft.description,
    `Literal auto-triggers: ${draft.triggers.join(", ")}`,
    "",
    draft.body,
  ].join("\n");
}

function comparableSkill(skill: Skill): string {
  return [
    skill.description,
    `Literal auto-triggers: ${(skill.trigger?.match ?? []).join(", ")}`,
    "",
    skill.body,
  ].join("\n");
}

function renderProposal(proposal: PendingProposal): string {
  const supporting =
    proposal.supportingSkills.length > 0
      ? [
          "",
          `Supporting skills considered (not refinement targets): ${proposal.supportingSkills.join(", ")}`,
        ]
      : [];
  if (proposal.kind === "create") {
    return [
      `Learned playbook draft: ${proposal.draft.name}`,
      completeDraft(proposal.draft),
      "",
      "Auto-invocation uses case-insensitive literal phrase matching. The first short trigger is the reusable intent anchor; the others narrow common phrasings.",
      ...supporting,
      "",
      "Review this draft, then run `/learn save project` or `/learn save global`.",
      "Run `/learn discard` to drop it. Nothing has been written yet.",
    ].join("\n");
  }
  const scope = proposal.target.skill.source;
  return [
    `Proposed update to learned playbook: ${proposal.target.skill.name}`,
    `Current source: ${scope} (${proposal.target.path})`,
    `Revision: ${proposal.target.skill.learned?.revision ?? 1} → ${(proposal.target.skill.learned?.revision ?? 1) + 1}`,
    "",
    "Complete revised playbook:",
    completeDraft(proposal.draft),
    "",
    "Auto-invocation uses case-insensitive literal phrase matching. The first short trigger is the reusable intent anchor; the others narrow common phrasings.",
    ...supporting,
    "",
    "Change summary:",
    diffLines(comparableSkill(proposal.target.skill), completeDraft(proposal.draft)),
    "",
    `Review this replacement, then run \`/learn save ${scope}\` to update it.`,
    "The current file will be backed up. Run `/learn discard` to leave it unchanged.",
  ].join("\n");
}

function meaningfullyChanged(skill: Skill, draft: PlaybookDraft): boolean {
  return comparableSkill(skill).trim() !== completeDraft(draft).trim();
}

/** Session-local controller: a draft must be reviewed before its exact contents can be saved. */
export class LearnPlaybookService implements LearnPlaybookController {
  private pending: PendingProposal | null = null;

  constructor(private readonly opts: LearnPlaybookServiceOptions) {}

  async propose(signal?: AbortSignal): Promise<string> {
    this.pending = null;
    const sessionId = this.opts.getSessionId();
    const result = latestLearnableTurn(this.opts.events.query(sessionId));
    if (!result.ok) return `Cannot learn from the previous turn: ${result.reason}.`;

    const invokedSkills = result.turn.invokedSkillNames
      .map((name) => this.opts.skills.get(name))
      .filter((skill): skill is Skill => skill !== undefined);
    const inferredLearnedMatches =
      invokedSkills.length === 0
        ? triggeredSkills(this.opts.skills.list(), result.turn.userInput).filter(
            (skill) => skill.learned,
          )
        : [];
    // Only Cleetus-managed learned playbooks are possible refinement targets. Built-ins and
    // user-authored skills may have helped the turn, but their presence must not prevent learning
    // a distinct residual procedure from the successful trajectory.
    const candidateSkills = [...invokedSkills, ...inferredLearnedMatches].filter(
      (skill, index, all) =>
        skill.learned && all.findIndex((candidate) => candidate.name === skill.name) === index,
    );
    if (candidateSkills.length > 1) {
      return [
        `Cannot choose a refinement target because the previous turn matched multiple learned playbooks: ${candidateSkills.map((skill) => skill.name).join(", ")}.`,
        "No draft was created. Consolidate their triggers or run a turn that invokes only the intended playbook.",
      ].join(" ");
    }
    let target: RevisionTarget | undefined;
    const invoked = candidateSkills[0];
    if (invoked) {
      if (!invoked.learned || invoked.source === "built-in" || !invoked.filePath) {
        return `The previous turn invoked ${invoked.source} skill '${invoked.name}', but it is not a Cleetus-managed learned playbook. /learn will not overwrite user-authored or built-in skills; edit it directly or create a deliberately separate skill.`;
      }
      if (invoked.baseDir) {
        return `The previous turn invoked directory skill '${invoked.name}'. /learn does not revise directory skills with bundled resources; edit its SKILL.md directly.`;
      }
      try {
        target = {
          skill: invoked,
          path: invoked.filePath,
          reviewedContent: await readFile(invoked.filePath, "utf8"),
        };
      } catch (error) {
        return `Cannot prepare an update to '${invoked.name}': ${(error as Error).message}. No draft was created.`;
      }
    }
    const supportingSkills = invokedSkills.filter((skill) => skill.name !== target?.skill.name);

    const active = this.opts.getActive();
    const callId = ulid();
    const operation = target ? "learn: playbook revision" : "learn: playbook draft";
    this.opts.eventSink?.append({
      sessionId,
      type: "model_call_start",
      payload: {
        callId,
        model: active.model,
        reason: operation,
      },
    });
    let telemetry: PlaybookSynthesisTelemetry | undefined;
    let failed = false;
    try {
      const draft = await synthesizePlaybook({
        provider: this.opts.providers.get(active.provider),
        model: active.model,
        turn: result.turn,
        signal,
        structuredOutput: this.opts.structuredOutput,
        modelFamily: this.opts.modelFamily,
        onFinish: (value) => {
          telemetry = value;
        },
        existingSkill: target?.skill,
        supportingSkills,
      });
      if (target && !meaningfullyChanged(target.skill, draft)) {
        return `The previous turn did not provide a durable improvement to '${target.skill.name}'. No update draft was kept.`;
      }
      this.pending = target
        ? {
            kind: "update",
            draft,
            target,
            supportingSkills: supportingSkills.map((skill) => skill.name),
          }
        : {
            kind: "create",
            draft,
            supportingSkills: supportingSkills.map((skill) => skill.name),
          };
      return renderProposal(this.pending);
    } catch (error) {
      failed = true;
      if (signal?.aborted) return "Playbook drafting cancelled; nothing was written.";
      return `Could not produce a grounded playbook draft: ${(error as Error).message}`;
    } finally {
      this.opts.eventSink?.append({
        sessionId,
        type: "model_call_end",
        payload: {
          callId,
          model: telemetry?.servedModel ?? active.model,
          reason:
            telemetry?.finishReason ??
            (failed ? (signal?.aborted ? "cancelled" : "error") : "stop"),
          usage: telemetry?.usage,
          operation,
          outcome: failed ? "error" : "ok",
        },
      });
    }
  }

  async save(scope: PlaybookScope): Promise<string> {
    if (!this.pending) return "There is no pending playbook draft. Run `/learn` first.";
    if (this.pending.kind === "update") {
      if (scope !== this.pending.target.skill.source) {
        return `This is an update to a ${this.pending.target.skill.source} playbook. Use \`/learn save ${this.pending.target.skill.source}\`; nothing was written.`;
      }
      const saved = await revisePlaybook(this.pending.draft, this.pending.target, {});
      this.opts.skills.upsert(saved.skill);
      this.pending = null;
      return `Updated ${scope} playbook at ${saved.path}. Previous revision backed up to ${saved.backupPath}. The revised playbook is active now.`;
    }

    const collision = this.opts.skills.get(this.pending.draft.name);
    if (collision) {
      return `A ${collision.source} skill named '${this.pending.draft.name}' already exists. Nothing was overwritten; discard this draft or rename the existing skill.`;
    }
    const saved = await savePlaybook(this.pending.draft, {
      scope,
      projectDir: this.opts.projectDir,
      globalDir: this.opts.globalDir,
    });
    this.opts.skills.upsert(saved.skill);
    this.pending = null;

    const activation =
      this.opts.skillsEnabled && this.opts.autoInvoke
        ? "It is active now and will auto-trigger on its configured phrases."
        : "It was saved, but automatic invocation is disabled by the current skills configuration.";
    return `Saved ${scope} playbook to ${saved.path}. ${activation}`;
  }

  discard(): string {
    if (!this.pending) return "There is no pending playbook draft.";
    const name = this.pending.draft.name;
    this.pending = null;
    return `Discarded learned playbook draft '${name}'.`;
  }

  status(): string {
    return this.pending ? renderProposal(this.pending) : "There is no pending playbook draft.";
  }
}
