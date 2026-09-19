import { isAbsolute, normalize, relative } from "node:path";
import type { LoopGuardConfig } from "../config/loop-guard";

const EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "multi_edit"]);
const CMD_TOOLS = new Set(["bash", "run_tests"]);
const READ_TOOLS = new Set(["read_file"]);

/** Dedicated cooldown key for the signature-agnostic escape rule. */
const ESCAPE_KEY = "__escape__";

/** Dedicated cooldown key for the signature-agnostic hidden-tool rule (WS5 N3). */
const HIDDEN_KEY = "__hidden__";

/** Collapse path spellings so `src/a.ts`, `./src/a.ts`, and `/root/src/a.ts` share one loop
 *  signature. Absolute paths under `projectRoot` relativize; absolute paths outside it keep
 *  their absolute form (the out-of-tree escape rule owns those). Pure. */
function normalizeSigPath(p: string, projectRoot?: string): string {
  const n = normalize(p);
  if (projectRoot && isAbsolute(n)) {
    const rel = relative(projectRoot, n);
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    return n;
  }
  return n;
}

/** Derive a loop signature for a tool call, or null when the tool is not tracked.
 *  Edits key by path; commands key by whitespace-normalized text; reads key by path; todo_write
 *  keys by its normalized content set (status ignored). Pure. */
export function signatureOf(name: string, args: unknown, projectRoot?: string): string | null {
  const a = (args ?? {}) as Record<string, unknown>;
  if (EDIT_TOOLS.has(name)) {
    const path = (a.path ?? a.file_path) as string | undefined;
    return path ? `edit:${normalizeSigPath(path, projectRoot)}` : null;
  }
  if (CMD_TOOLS.has(name)) {
    const cmd = a.command as string | undefined;
    if (!cmd) return null;
    return `cmd:${cmd.trim().replace(/\s+/g, " ")}`;
  }
  if (READ_TOOLS.has(name)) {
    const path = (a.path ?? a.file_path) as string | undefined;
    return path ? `read:${normalizeSigPath(path, projectRoot)}` : null;
  }
  if (name === "todo_write") {
    const todos = a.todos as Array<{ content?: unknown }> | undefined;
    if (!Array.isArray(todos)) return null;
    // Normalize on the set of trimmed content strings; ignore `status` so "same plan, status
    // toggled" collapses to one signature. A materially different list yields a new signature.
    const digest = todos
      .map((t) =>
        String(t?.content ?? "")
          .trim()
          .replace(/\s+/g, " "),
      )
      .join("|");
    return `todo:${digest}`;
  }
  return null;
}

/** Catch a narrow diagnostic loop: successive successful shell probes whose commands differ
 * only by a numbered label and whose visible results are otherwise identical. This deliberately
 * does not count ordinary inspection commands or outputs whose value changes. Scoped to one turn. */
export class RepeatedProbeGuard {
  private previous: { command: string; family: string; result: string; count: number } | null = null;

  constructor(private readonly warningAt: number) {}

  observe(
    call: { name: string; args: unknown },
    outcome: { ok: boolean; output?: string },
  ): { kind: "warn" | "stop"; count: number } | null {
    if (EDIT_TOOLS.has(call.name) && outcome.ok) {
      this.previous = null;
      return null;
    }
    const command = (call.args as { command?: unknown } | null)?.command;
    if (call.name !== "bash" || !outcome.ok || typeof command !== "string") {
      this.previous = null;
      return null;
    }
    const family = command.replace(/\b([A-Za-z_][\w-]*?)\d+(?=:)/g, "$1#");
    const output = outcome.output?.replace(/^\s*[A-Za-z_][\w-]*?\d+:\s*/, "").trim();
    if (family === command || !output || output === outcome.output?.trim()) {
      this.previous = null;
      return null;
    }
    const previous = this.previous;
    const count =
      previous &&
      previous.family === family &&
      previous.result === output &&
      previous.command !== command
        ? previous.count + 1
        : 1;
    this.previous = { command, family, result: output, count };
    if (count === this.warningAt) return { kind: "warn", count };
    if (count === this.warningAt * 2) return { kind: "stop", count };
    return null;
  }
}

/** Give a specific recovery lead when the repeated probe itself exposes a likely test defect. */
export function repeatedProbeRecoveryAdvice(command: string): string {
  if (/\bdocument\.dispatchEvent\s*\(/.test(command)) {
    return "This probe re-dispatches an event on document, which changes its target. Save the original clicked element and call the shared handler with it, or dispatch a new event on that element; then test the early-click path once.";
  }
  return "Inspect the code path and test assertion once, make one hypothesis-driven change, then run one focused check. If the result still repeats, report the observed and expected values as an unresolved limitation.";
}

interface WindowEntry {
  signature: string;
  ok: boolean;
  outOfTree: boolean;
  hiddenTool: boolean;
}

/** Per-session detector for no-progress loops. `observe` is called once per completed tool
 *  call and returns a warning string to append to that call's result, or null. Stateful only
 *  in its own ring buffer + cooldown map. */
export class LoopGuard {
  private window: WindowEntry[] = [];
  private callCounter = 0;
  /** signature → callCounter value at which it last warned. */
  private lastWarnedAt = new Map<string, number>();
  /** signature → number of fail/stall warnings emitted for it. Cleared on any successful edit. */
  private warnCount = new Map<string, number>();
  /** signature → consecutive failing occurrences of this exact command. Deleted by any
   *  SUCCESSFUL run of the same command (red→green). Independent of the window / warnCount /
   *  cooldown machinery, so neither an intervening successful edit (the #248 TDD exemption)
   *  nor a tight burst inside the cooldown can suppress it. Only consulted in worker context. */
  private cmdFailStreak = new Map<string, number>();
  /** signature → consecutive FAILED edits of this exact path. Cleared ONLY by a successful
   *  edit or a successful read of the SAME path (re-reading is the corrective action the
   *  warning demands, and it guarantees a gated path can never be permanently bricked).
   *  Cross-path successes never launder another path's streak — unlike warnCount's global
   *  progress reset, which is deliberate for commands (#248 TDD reopen) and unchanged. */
  private editFailStreak = new Map<string, number>();

  constructor(
    private readonly cfg: LoopGuardConfig,
    private readonly projectRoot?: string,
  ) {}

  observe(
    call: { name: string; args: unknown },
    outcome: { ok: boolean; outOfTree?: boolean; hiddenTool?: boolean },
  ): string | null {
    this.callCounter++;
    const signature = outcome.hiddenTool
      ? `hidden:${call.name}`
      : signatureOf(call.name, call.args, this.projectRoot);
    if (!signature) return null;

    // Progress reset: a landed edit means real change happened — reopen any blocked signature.
    if (outcome.ok && signature.startsWith("edit:")) this.warnCount.clear();

    // Worker-thrash streak (additive; consulted only via thrashedSignature). A passing run of a
    // command clears its streak; a failing run extends it. Edits/reads never touch it.
    if (signature.startsWith("cmd:")) {
      if (outcome.ok) this.cmdFailStreak.delete(signature);
      else this.cmdFailStreak.set(signature, (this.cmdFailStreak.get(signature) ?? 0) + 1);
    }

    if (signature.startsWith("edit:")) {
      if (outcome.ok) this.editFailStreak.delete(signature);
      else this.editFailStreak.set(signature, (this.editFailStreak.get(signature) ?? 0) + 1);
    }
    // A successful re-read of a path clears its edit-fail streak: the model did what the
    // editfail warning asks, and the next attempt deserves fresh headroom.
    if (signature.startsWith("read:") && outcome.ok) {
      this.editFailStreak.delete(signature.replace(/^read:/, "edit:"));
    }

    this.window.push({
      signature,
      ok: outcome.ok,
      outOfTree: outcome.outOfTree === true,
      hiddenTool: outcome.hiddenTool === true,
    });
    if (this.window.length > this.cfg.windowSize) this.window.shift();

    // Escape rule (signature-agnostic): repeated attempts to operate outside the project root,
    // regardless of target. Catches derails that vary their path/command each call. Own cooldown key.
    const escapes = this.window.filter((r) => r.outOfTree).length;
    if (escapes >= this.cfg.escapeThreshold) {
      const escapeWarnedAt = this.lastWarnedAt.get(ESCAPE_KEY);
      if (escapeWarnedAt === undefined || this.callCounter - escapeWarnedAt > this.cfg.cooldown) {
        this.lastWarnedAt.set(ESCAPE_KEY, this.callCounter);
        return formatLoopWarning("escape", signature, escapes);
      }
    }

    // Hidden-tool rule (signature-agnostic, WS5 N3): repeated calls to tools hidden at this
    // capability, regardless of which tool — cycling git_status → git_diff → git_log is one
    // behavior. Own cooldown key. Hidden entries are fully handled here.
    if (outcome.hiddenTool) {
      const hidden = this.window.filter((r) => r.hiddenTool).length;
      // Saturate at windowSize (like the runtime's 2x abort trigger): the count is
      // window-capped, so an unclamped larger threshold would never fire.
      if (hidden >= Math.min(this.cfg.hiddenRepeatThreshold, this.cfg.windowSize)) {
        const hiddenWarnedAt = this.lastWarnedAt.get(HIDDEN_KEY);
        if (hiddenWarnedAt === undefined || this.callCounter - hiddenWarnedAt > this.cfg.cooldown) {
          this.lastWarnedAt.set(HIDDEN_KEY, this.callCounter);
          return formatLoopWarning("hidden", signature, hidden);
        }
      }
      return null;
    }

    const warnedAt = this.lastWarnedAt.get(signature);
    if (warnedAt !== undefined && this.callCounter - warnedAt <= this.cfg.cooldown) {
      return null;
    }

    const matching = this.window.filter((r) => r.signature === signature);

    const editFails = this.editFailStreak.get(signature) ?? 0;
    if (signature.startsWith("edit:") && editFails >= this.cfg.failRepeatThreshold) {
      this.lastWarnedAt.set(signature, this.callCounter);
      return formatLoopWarning("editfail", signature, editFails);
    }

    if (signature.startsWith("edit:") && matching.length >= this.cfg.editRepeatThreshold) {
      this.lastWarnedAt.set(signature, this.callCounter);
      return formatLoopWarning("edit", signature, matching.length);
    }
    // Fail detection requires EVERY in-window occurrence of this command to have failed
    // (not merely the most recent N consecutively). Since windowSize ≫ failRepeatThreshold,
    // a single success anywhere in the window resets the condition — stricter than literal
    // "N in a row", which keeps false positives low.
    if (
      signature.startsWith("cmd:") &&
      matching.length >= this.cfg.failRepeatThreshold &&
      matching.every((r) => !r.ok)
    ) {
      // Suppress when the model landed a SUCCESSFUL edit between the failures — a legitimate
      // red -> edit -> red TDD loop, not a stuck command. Mirrors the stall rule's mutationAfter,
      // but keyed on a successful edit (a failed edit changed nothing), matching the progress
      // reset above that only clears warnCount on a successful edit.
      const firstIdx = this.window.findIndex((r) => r.signature === signature);
      const progressAfter = this.window
        .slice(firstIdx + 1)
        .some((r) => r.ok && r.signature.startsWith("edit:"));
      if (!progressAfter) {
        this.lastWarnedAt.set(signature, this.callCounter);
        this.warnCount.set(signature, (this.warnCount.get(signature) ?? 0) + 1);
        return formatLoopWarning("fail", signature, matching.length);
      }
    }
    // General no-progress rule: the same tracked signature repeated noProgressThreshold times,
    // regardless of exit code (re-listing, re-reading, re-planning). Excludes edit: signatures
    // (handled by the edit rule with its own threshold/messaging). Suppressed when a real
    // mutation (an edit: call) appears in the window after this signature's first occurrence —
    // that means the model is actually changing files between repeats.
    if (!signature.startsWith("edit:") && matching.length >= this.cfg.noProgressThreshold) {
      const firstIdx = this.window.findIndex((r) => r.signature === signature);
      const mutationAfter = this.window
        .slice(firstIdx + 1)
        .some((r) => r.signature.startsWith("edit:"));
      if (!mutationAfter) {
        this.lastWarnedAt.set(signature, this.callCounter);
        this.warnCount.set(signature, (this.warnCount.get(signature) ?? 0) + 1);
        return formatLoopWarning("stall", signature, matching.length);
      }
    }
    return null;
  }

  /** Pre-dispatch escalation: refuse a call whose fail/stall signature has already warned
   *  `blockThreshold` times (and has not been reset by an intervening successful edit), or
   *  whose edit signature has failed `failRepeatThreshold + blockThreshold` consecutive times
   *  (and has not been reset by a successful edit or read of the same path). Returns the block
   *  guidance to use as the tool result, or null to allow the call. Pure w.r.t. external state.
   *  Escapes are never gated. */
  gate(call: { name: string; args: unknown }): string | null {
    if (this.cfg.blockThreshold <= 0) return null;
    const signature = signatureOf(call.name, call.args, this.projectRoot);
    if (!signature) return null;
    // Edit gating rides the consecutive-fail streak directly (never warnCount, whose global
    // progress reset is command semantics): refused only after failRepeatThreshold warnings-worth
    // plus blockThreshold more consecutive failures, and a successful read of the path lifts it.
    if (signature.startsWith("edit:")) {
      const streak = this.editFailStreak.get(signature) ?? 0;
      if (streak >= this.cfg.failRepeatThreshold + this.cfg.blockThreshold) {
        return formatEditBlock(signature, streak);
      }
      return null;
    }
    const count = this.warnCount.get(signature) ?? 0;
    if (count >= this.cfg.blockThreshold) return formatLoopBlock(signature, count);
    return null;
  }

  /** The command signature whose consecutive-failure streak has reached `threshold`, or null.
   *  `threshold <= 0` disables (returns null). Pure w.r.t. external state. */
  thrashedSignature(threshold: number): string | null {
    if (threshold <= 0) return null;
    for (const [sig, count] of this.cmdFailStreak) {
      if (count >= threshold) return sig;
    }
    return null;
  }

  /** Clear the consecutive-failure streak for one command signature (or all cmd streaks when
   *  omitted). Called when a thrash stop is emitted so a subsequent turn's retry starts fresh. */
  clearCmdFailStreak(signature?: string): void {
    if (signature) this.cmdFailStreak.delete(signature);
    else this.cmdFailStreak.clear();
  }

  /** Hidden-tool rejections currently in the window (WS5 N3). Consulted by the runtime for
   *  the 2x-threshold turn abort. Pure w.r.t. external state. */
  hiddenRepeats(): number {
    return this.window.filter((r) => r.hiddenTool).length;
  }
}

/** Build the `<loop-warning>` block. Bounded — only the signature label + count are
 *  interpolated (never file contents or command output), so it adds negligible tokens. */
export function formatLoopWarning(
  kind: "edit" | "fail" | "stall" | "escape" | "editfail" | "hidden",
  signature: string,
  count: number,
): string {
  const label = signature.replace(/^(edit|cmd|read|todo|hidden):/, "");
  let body: string;
  if (kind === "edit") {
    body = `You have edited ${label} ${count} times in this session without the task converging. Stop repeating the same change. Re-read the current file state, identify why the previous attempts did not work (e.g. a wrong dependency version or API signature), and try a materially different approach — or ask the user for guidance.`;
  } else if (kind === "editfail") {
    body = `Your last ${count} edits to ${label} all failed to apply — the old_text you are sending does not match the file. Stop guessing at the file's contents: use read_file on ${label} and copy the exact text (whitespace included) into old_text, then re-issue the edit.`;
  } else if (kind === "hidden") {
    body = `You have called tools that are not available in this session ${count} times (most recently ${label}). They will never run here. Use the alternatives the error messages name — edit_file for edits, bash for git and shell commands, todo_write for the todo list — and do not call unavailable tools again.`;
  } else if (kind === "fail") {
    body = `The command \`${label}\` has failed ${count} times in a row. Repeating it will not help. Read the actual error output above, change your approach (different dependency version, fix the source it points to, or a different command), or ask the user.`;
  } else if (kind === "escape") {
    body = `You have attempted to operate outside the project root ${count} times. This session is confined to the project directory — files outside it (including cleetus's own config and instructions) are off-limits, and writes there are blocked. Stop trying to access paths outside the project; complete the task within the project directory, or if you genuinely need something outside it, stop and ask the user.`;
  } else {
    body = `You have repeated the same action (${label}) ${count} times without making progress — no files have changed in between. Re-listing, re-reading, or re-planning will not advance the task. Take a concrete next step: write or edit the file the task needs, run the build, or if you are blocked say what is blocking you and ask the user. Do not repeat this action again.`;
  }
  return `<loop-warning>\n${body}\n</loop-warning>`;
}

/** Build the `<loop-block>` refusal block. Bounded — only the signature label + count are
 *  interpolated (never file contents or command output). */
export function formatLoopBlock(signature: string, count: number): string {
  const label = signature.replace(/^(edit|cmd|read|todo):/, "");
  const body = `This call was refused. You have repeated \`${label}\` ${count} times despite warnings, with no file change in between, so it will not run again until you make a real change. Take a different action: fix the underlying problem, run a different command, or say what is blocking you and ask the user. Repeating this exact call will keep being refused.`;
  return `<loop-block>\n${body}\n</loop-block>`;
}

/** Refusal for an edit whose consecutive-failure streak exceeded the gate. Bounded — only
 *  the path label + count are interpolated. */
export function formatEditBlock(signature: string, count: number): string {
  const label = signature.replace(/^edit:/, "");
  const body = `This edit was refused: ${count} consecutive edits to ${label} failed to apply. Use read_file on ${label} first to see its current exact contents — a successful read clears this block — then re-issue the edit with old_text copied verbatim from the file.`;
  return `<loop-block>\n${body}\n</loop-block>`;
}
