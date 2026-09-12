import type { Event } from "../events/types";
import type { Session } from "./session";

export interface SessionPreview {
  id: string;
  model: string;
  /** First user message, collapsed to one line and capped. Empty string when none. */
  preview: string;
  createdAt: number;
}

const PREVIEW_MAX = 60;

/** Derive a picker entry from a session and its events. `preview` is the first
 *  `user_input` text, whitespace-collapsed and capped at PREVIEW_MAX (… when cut). */
export function sessionPreview(session: Session, events: Event[]): SessionPreview {
  const first = events.find((e) => e.type === "user_input");
  const raw = first ? String((first.payload as { text?: unknown }).text ?? "") : "";
  const clean = raw.replace(/\s+/g, " ").trim();
  const preview = clean.length <= PREVIEW_MAX ? clean : `${clean.slice(0, PREVIEW_MAX - 1)}…`;
  return { id: session.id, model: session.model, preview, createdAt: session.createdAt };
}
