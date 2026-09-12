import type { Message } from "../../providers/types";
import { stripSystemReminders } from "../../skills/compose";
import { messageTokens } from "./window";

/** Thrown by the summarizer call when it exceeds its per-chunk timeout. Treated as
 *  non-retryable by `summarizeWithRetry` (a slow model would just time out again). */
export class SummaryTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`summarizer timed out after ${timeoutMs}ms`);
    this.name = "SummaryTimeoutError";
  }
}

export interface DigestState {
  text: string;
  /** Count of leading history messages already represented by `text`. */
  coveredThroughIndex: number;
}

/** Hard cap on digest length (~1000 tokens). The prompt asks for ~20 lines, but a
 *  non-compliant local summarizer could over-produce and blow the reserved budget;
 *  this is the belt-and-suspenders floor under that risk. */
const MAX_DIGEST_CHARS = 4000;

export const DIGEST_SYSTEM_PROMPT =
  "You maintain a running digest of a coding session whose older messages are being " +
  "dropped to fit the context window. Given the existing digest and newer messages, " +
  "produce an UPDATED digest that preserves: files created/edited (with paths), key " +
  "decisions, commands run and their outcomes, and open/unfinished tasks. Be factual " +
  "and terse. This is historical context, not the active task: never present an older request " +
  "as current or instruct the agent to resume it. Output ONLY the digest, at most ~20 lines. " +
  "Do not add commentary.";

function messageToText(m: Message): string {
  const calls = (m.toolCalls ?? [])
    .map((c) => `\n  → tool ${c.name}(${JSON.stringify(c.args)})`)
    .join("");
  return `${m.role}: ${m.content}${calls}`;
}

/** Render the summarizer's user message: prior digest + the new slice to fold in. */
export function renderSliceForSummary(
  oldText: string,
  slice: Message[],
  instruction?: string,
): string {
  const prior = oldText ? `Existing digest:\n${oldText}\n\n` : "";
  const focus = instruction ? `\n\nFocus the summary on: ${instruction}` : "";
  const newer = slice.map(messageToText).join("\n");
  return `${prior}Newer messages to fold into the digest:\n${newer}${focus}`;
}

const EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "multi_edit"]);
const CMD_TOOLS = new Set(["bash", "run_tests", "smoke_run", "render_check"]);

/** Deterministic fallback digest: scrape file paths edited and commands run from a slice.
 *  Used when the summarizer fails so trimmed context is never lost wholesale. Pure. */
export function extractiveDigest(slice: Message[], evidence: Message[] = slice): string {
  const lines: string[] = [];
  const results = new Map(
    evidence.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m.content]),
  );
  for (const m of slice) {
    if (m.role === "user" && m.userRequest !== null) {
      const request = stripSystemReminders(m.userRequest ?? m.content).trim();
      if (request) lines.push(`- user decision/request: ${request.slice(0, 700)}`);
    }
    for (const c of m.toolCalls ?? []) {
      const args = (c.args ?? {}) as Record<string, unknown>;
      if (EDIT_TOOLS.has(c.name)) {
        const path = (args.path ?? args.file_path) as string | undefined;
        if (path)
          lines.push(
            `- edit attempted ${path}${results.has(c.id) ? `: ${results.get(c.id)!.slice(0, 300)}` : " (outcome not recorded)"}`,
          );
      } else if (CMD_TOOLS.has(c.name)) {
        const cmd =
          typeof args.command === "string" ? args.command : `${c.name} ${JSON.stringify(args)}`;
        if (cmd)
          lines.push(
            `- ran: ${cmd.slice(0, 120)}${results.has(c.id) ? ` => ${results.get(c.id)!.slice(0, 500)}` : " (outcome not recorded)"}`,
          );
      }
    }
  }
  const uniq = [...new Set(lines)].slice(-40);
  return uniq.length ? `Files edited and commands run in trimmed context:\n${uniq.join("\n")}` : "";
}

/** Split a slice into consecutive sub-slices each costing at most `maxTokens`. A single
 *  message larger than the cap becomes its own chunk. */
function chunkSlice(slice: Message[], maxTokens: number): Message[][] {
  const chunks: Message[][] = [];
  let cur: Message[] = [];
  let curTokens = 0;
  for (const m of slice) {
    const t = messageTokens(m);
    if (cur.length > 0 && curTokens + t > maxTokens) {
      chunks.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(m);
    curTokens += t;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** One summarizer attempt with a single retry; returns null on double failure, empty output, or
 *  a SummaryTimeoutError (which skips the retry — a slow model would just time out again). */
async function summarizeWithRetry(
  summarize: (
    oldText: string,
    slice: Message[],
    instruction?: string,
    timeoutMs?: number,
  ) => Promise<string>,
  oldText: string,
  chunk: Message[],
  instruction: string | undefined,
  deadlineAt: number | null,
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const remaining = deadlineAt === null ? undefined : Math.max(0, deadlineAt - Date.now());
      if (remaining !== undefined && remaining <= 0) return null;
      const out = (await summarize(oldText, chunk, instruction, remaining)).trim();
      if (out) return out;
    } catch (e) {
      if (e instanceof SummaryTimeoutError) return null; // no retry — fall back deterministically
      // else fall through to retry / fallback
    }
  }
  return null;
}

/**
 * Fold `slice` into the rolling digest resiliently. Sub-chunks the slice when it exceeds
 * `maxSummaryInputTokens`, summarizes each chunk (one retry), and on chunk failure appends
 * an extractive digest of that chunk instead of dropping it. Coverage always advances to
 * `newCoveredThroughIndex`; the digest is never left empty for a non-empty slice.
 *
 * `ok` is true only when every chunk summarized cleanly. `partial` is true when any chunk
 * used the extractive fallback.
 */
export async function compact(
  old: DigestState | undefined,
  slice: Message[],
  newCoveredThroughIndex: number,
  summarize: (
    oldText: string,
    slice: Message[],
    instruction?: string,
    timeoutMs?: number,
  ) => Promise<string>,
  opts: { maxSummaryInputTokens: number; instruction?: string; maxElapsedMs?: number },
): Promise<{ state: DigestState; ok: boolean; partial: boolean }> {
  let text = old?.text ?? "";
  let ok = true;
  let partial = false;
  const deadlineAt =
    opts.maxElapsedMs === undefined ? null : Date.now() + Math.max(1, opts.maxElapsedMs);
  for (const chunk of chunkSlice(slice, opts.maxSummaryInputTokens)) {
    const summary = await summarizeWithRetry(summarize, text, chunk, opts.instruction, deadlineAt);
    if (summary !== null) {
      text = summary;
    } else {
      ok = false;
      partial = true;
      const extractive = extractiveDigest(chunk, slice);
      if (extractive) text = text ? `${text}\n\n${extractive}` : extractive;
    }
  }
  // On degraded summaries, newest evidence wins. Never advance coverage while discarding
  // all of the newly folded facts behind an already-full old digest.
  text = partial ? text.slice(-MAX_DIGEST_CHARS) : text.slice(0, MAX_DIGEST_CHARS);
  return { state: { text, coveredThroughIndex: newCoveredThroughIndex }, ok, partial };
}

/** The synthetic message carrying the digest, placed right after the system prompt.
 *  Returns null for an empty digest. */
export function buildDigestMessage(text: string): Message | null {
  if (!text.trim()) return null;
  return {
    role: "user",
    content: `[Earlier in this session — historical context trimmed to fit the window]\nThe separately preserved latest user message is the active task. Do not resume an older request from this digest unless that active message explicitly asks you to.\n\n${text}`,
  };
}
