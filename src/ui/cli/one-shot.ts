import type { AgentRuntime } from "../../agent/runtime";
import type { SessionStore } from "../../agent/session";
import type { SessionHistoryStore } from "../../agent/session-history";
import type { EventLog } from "../../events/log";
import { isEventVisible } from "../../events/types";
import type { ImageRef } from "../../providers/types";

export interface OneShotOptions {
  runtime: AgentRuntime;
  log: EventLog;
  sessions: SessionStore;
  provider: string;
  model: string;
  prompt: string;
  write: (chunk: string) => void;
  resumeSessionId?: string;
  /** When present, resuming a session also restores its exact conversation snapshot. */
  historyStore?: SessionHistoryStore;
  /** Show warning and internal diagnostic notices in the output stream. */
  verbose?: boolean;
  /** Resolved image attachments (from --image flags and/or in-prompt detection). */
  attachments?: ImageRef[];
}

export async function runOneShot(opts: OneShotOptions): Promise<number> {
  const session = opts.resumeSessionId
    ? (opts.sessions.get(opts.resumeSessionId) ??
      opts.sessions.create({ provider: opts.provider, model: opts.model }))
    : opts.sessions.create({ provider: opts.provider, model: opts.model });

  // Restore the exact conversation history when resuming an existing session.
  if (opts.resumeSessionId) {
    const snap = opts.historyStore?.load(opts.resumeSessionId);
    if (snap) opts.runtime.loadSession(session.id, snap.messages, snap.todos);
  }

  const unsub = opts.log.subscribe(session.id, (e) => {
    if (!isEventVisible(e, opts.verbose)) return;
    if (e.type === "model_call_chunk") {
      opts.write((e.payload as { text: string }).text);
    } else if (e.type === "tool_call_start") {
      const call = (e.payload as { call: { name: string } }).call;
      opts.write(`\n[tool: ${call.name}]\n`);
    } else if (e.type === "error") {
      opts.write(`\n[error: ${(e.payload as { message: string }).message}]\n`);
    } else if (e.type === "notice") {
      opts.write(`\n[notice: ${(e.payload as { text: string }).text}]\n`);
    }
  });
  try {
    await opts.runtime.runTurn(
      session.id,
      opts.prompt,
      undefined,
      undefined,
      undefined,
      opts.attachments,
    );
    opts.write("\n");
    return 0;
  } catch (e) {
    opts.write(`\n[failed: ${(e as Error).message}]\n`);
    return 1;
  } finally {
    unsub();
  }
}
