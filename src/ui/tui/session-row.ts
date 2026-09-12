import type { SessionPreview } from "../../agent/session-preview";
import { formatAge } from "./format-age";

export interface SessionRow {
  id: string;
  label: string;
}

/** Picker rows: "<id> · <age> · <model> · <preview>". Caller supplies previews already
 *  ordered (most-recent first); ordering is preserved. */
export function sessionRows(previews: SessionPreview[], now: number): SessionRow[] {
  return previews.map((p) => ({
    id: p.id,
    label: `${p.id} · ${formatAge(now - p.createdAt)} · ${p.model} · ${p.preview || "(no messages)"}`,
  }));
}
