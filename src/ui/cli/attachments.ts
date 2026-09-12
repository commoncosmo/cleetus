import { homedir } from "node:os";
import { join } from "node:path";
import { gcAttachments } from "../../agent/attachment-gc";
import { ensureParentDir, resolveSessionDbPath } from "../../agent/session-db-path";
import { SessionHistoryStore } from "../../agent/session-history";
import { loadConfig } from "../../config/loader";
import { openDatabase } from "../../lib/db";

interface Io {
  write: (s: string) => void;
  writeErr: (s: string) => void;
}

/** `cleetus attachments gc [--dry-run]` — orphan-only sweep of `.cleetus/attachments/`.
 *  Self-contained: no TUI/MCP/provider boot (mirrors runAnalyze). */
export async function runAttachments(argv: string[], cwd: string, io: Io): Promise<number> {
  if (argv[3] !== "gc") {
    io.writeErr("usage: cleetus attachments gc [--dry-run]\n");
    return 2;
  }
  const dryRun = argv.includes("--dry-run");
  // Global config path mirrors cleetus.ts/analyze.ts (a module-local const, not exported from anywhere).
  const GLOBAL_CONFIG = join(homedir(), ".config", "cleetus", "config.yaml");
  const config = await loadConfig({ globalPath: GLOBAL_CONFIG, projectDir: cwd });

  const dbPath = resolveSessionDbPath(cwd);
  ensureParentDir(dbPath);
  const db = openDatabase(dbPath);
  new SessionHistoryStore(db); // guarantee the session_history table exists before reconciling
  try {
    const res = gcAttachments({
      storeDir: join(cwd, ".cleetus", "attachments"),
      db,
      minAgeMs: config.attachments.gcMinAgeHours * 60 * 60 * 1000,
      dryRun,
    });
    const mb = (res.bytesReclaimed / (1024 * 1024)).toFixed(1);
    io.write(
      `scanned ${res.scanned} · orphans ${res.orphans} · ${dryRun ? "would reclaim" : "reclaimed"} ${mb} MB\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}
