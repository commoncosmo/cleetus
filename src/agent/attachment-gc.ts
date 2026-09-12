import type { Database } from "bun:sqlite";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AttachmentsConfig } from "../config/attachments";

/** Content-addressed attachment file: `<64-hex-sha256>.<ext>`. Anything else is never a candidate. */
const ATTACHMENT_RE = /^[0-9a-f]{64}\.[a-z0-9]+$/;

/** Every sha256 referenced by any persisted session snapshot (the "keep" set).
 *  Reads `session_history.messages` JSON; the table must already exist (construct a
 *  SessionHistoryStore first). A row whose JSON won't parse is skipped so it can't abort the scan
 *  and drop every other row's references — such a row is already non-resumable
 *  (`SessionHistoryStore.load` parses it unguarded), so contributing no shas from it is safe. */
export function collectReferencedSha256(db: Database): Set<string> {
  const set = new Set<string>();
  const rows = db.query<{ messages: string }, []>("SELECT messages FROM session_history").all();
  for (const row of rows) {
    let messages: unknown;
    try {
      messages = JSON.parse(row.messages);
    } catch {
      continue;
    }
    if (!Array.isArray(messages)) continue;
    for (const m of messages) {
      const images = (m as { images?: unknown })?.images;
      if (!Array.isArray(images)) continue;
      for (const img of images) {
        const sha = (img as { sha256?: unknown })?.sha256;
        if (typeof sha === "string") set.add(sha);
      }
    }
  }
  return set;
}

/** Content-addressed attachment file names in `storeDir`, via a single readdir. Non-attachment
 *  files are filtered out (never returned); returns [] when the directory doesn't exist yet. */
function listAttachmentNames(storeDir: string): string[] {
  try {
    return readdirSync(storeDir).filter((name) => ATTACHMENT_RE.test(name));
  } catch {
    return []; // no attachments dir yet
  }
}

/** From a pre-listed set of attachment names, the ones eligible for deletion: unreferenced and
 *  older than the grace window. Split out so one readdir feeds both the scan count and the search. */
function orphansFromNames(
  names: string[],
  storeDir: string,
  referenced: Set<string>,
  opts: { now: number; minAgeMs: number },
): { path: string; bytes: number }[] {
  const orphans: { path: string; bytes: number }[] = [];
  for (const name of names) {
    if (referenced.has(name.slice(0, 64))) continue; // sha256 stem is referenced → keep
    const full = join(storeDir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (opts.now - st.mtimeMs < opts.minAgeMs) continue; // grace window (in-flight / concurrency guard)
    orphans.push({ path: full, bytes: st.size });
  }
  return orphans;
}

/** Attachment files eligible for deletion: matching the content-addressed shape, unreferenced,
 *  and older than the grace window. `now`/`minAgeMs` are injected for deterministic tests. */
export function findOrphans(
  storeDir: string,
  referenced: Set<string>,
  opts: { now: number; minAgeMs: number },
): { path: string; bytes: number }[] {
  return orphansFromNames(listAttachmentNames(storeDir), storeDir, referenced, opts);
}

export interface GcResult {
  scanned: number;
  orphans: number;
  bytesReclaimed: number;
  deleted: number;
}

/** Orphan-only sweep. `dryRun` reports counts without deleting. */
export function gcAttachments(opts: {
  storeDir: string;
  db: Database;
  minAgeMs: number;
  dryRun: boolean;
  now?: number;
}): GcResult {
  const now = opts.now ?? Date.now();
  const referenced = collectReferencedSha256(opts.db);
  const names = listAttachmentNames(opts.storeDir); // single readdir feeds both scanned + orphans
  const orphans = orphansFromNames(names, opts.storeDir, referenced, {
    now,
    minAgeMs: opts.minAgeMs,
  });
  let bytesReclaimed = 0;
  let deleted = 0;
  for (const o of orphans) {
    if (opts.dryRun) {
      bytesReclaimed += o.bytes; // would-be reclaim; nothing deleted
      continue;
    }
    try {
      rmSync(o.path, { force: true });
      deleted++;
      bytesReclaimed += o.bytes; // count only bytes actually freed
    } catch {}
  }
  return { scanned: names.length, orphans: orphans.length, bytesReclaimed, deleted };
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Opt-in startup sweep. No-op (zeros) when disabled; emits one line via `report` if anything was
 *  reclaimed. Runs the real deletion (dryRun: false). */
export function maybeGcOnStartup(
  cfg: AttachmentsConfig,
  storeDir: string,
  db: Database,
  report?: (line: string) => void,
): GcResult {
  if (!cfg.gcOnStartup) return { scanned: 0, orphans: 0, bytesReclaimed: 0, deleted: 0 };
  const res = gcAttachments({
    storeDir,
    db,
    minAgeMs: cfg.gcMinAgeHours * 60 * 60 * 1000,
    dryRun: false,
  });
  if (res.deleted > 0) {
    report?.(
      `[cleetus] attachments gc: reclaimed ${formatMb(res.bytesReclaimed)} (${res.deleted} files)`,
    );
  }
  return res;
}
