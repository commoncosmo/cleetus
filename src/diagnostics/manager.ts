import { resolve } from "node:path";
import { computeNew, countFixed, toMultiset } from "./diff";
import { formatReport } from "./format";
import { toRelative } from "./relpath";
import type {
  CheckReport,
  CheckStatus,
  Diagnostic,
  DiagnosticExec,
  DiagnosticsProvider,
  ResolvedCmd,
  RunOutcome,
} from "./types";

export interface ManagerProvider {
  provider: DiagnosticsProvider;
  cmd: ResolvedCmd;
}

export interface DiagnosticsManagerOptions {
  projectDir: string;
  providers: ManagerProvider[];
  timeoutMs: number;
  maxReported: number;
  exec?: DiagnosticExec;
}

export class DiagnosticsManager {
  private readonly baseline = new Map<string, Map<string, number>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private seedPromise: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: DiagnosticsManagerOptions) {}

  /** Run all providers once in the background to establish baselines. Fire-and-forget; call once per session. */
  seed(signal: AbortSignal): void {
    this.seedPromise = Promise.allSettled(
      this.opts.providers.map((mp) =>
        this.withLock(mp.provider.id, async () => {
          if (this.baseline.has(mp.provider.id)) return;
          const outcome = await mp.provider.run(
            mp.cmd,
            this.opts.projectDir,
            signal,
            this.opts.timeoutMs,
            this.opts.exec,
          );
          if (outcome.available && !outcome.timedOut) {
            this.baseline.set(mp.provider.id, toMultiset(outcome.diagnostics));
          }
        }),
      ),
    );
  }

  /** Test-only barrier: resolves when the in-flight seed completes. */
  async whenSeeded(): Promise<void> {
    await this.seedPromise;
  }

  /** Check a single edited file's language. Returns null when no provider matches. */
  async check(file: string, signal: AbortSignal): Promise<CheckReport | null> {
    const [report] = await this.checkFiles([file], signal);
    return report ?? null;
  }

  /**
   * Coalesce a step's edits: run each DISTINCT matching provider exactly once over
   * the net change, diffing against its baseline. Files with no matching provider
   * contribute nothing. Reports come back in first-seen provider order.
   */
  async checkFiles(files: string[], signal: AbortSignal): Promise<CheckReport[]> {
    const byProvider = new Map<string, { mp: ManagerProvider; files: string[] }>();
    for (const file of files) {
      const mp = this.opts.providers.find((p) => p.provider.matches(file));
      if (!mp) continue;
      const entry = byProvider.get(mp.provider.id) ?? { mp, files: [] };
      entry.files.push(file);
      byProvider.set(mp.provider.id, entry);
    }
    const reports: CheckReport[] = [];
    for (const { mp, files: matched } of byProvider.values()) {
      reports.push(await this.withLock(mp.provider.id, () => this.runAndDiff(mp, matched, signal)));
    }
    return reports;
  }

  private async runAndDiff(
    mp: ManagerProvider,
    files: string[],
    signal: AbortSignal,
  ): Promise<CheckReport> {
    const outcome = await mp.provider.run(
      mp.cmd,
      this.opts.projectDir,
      signal,
      this.opts.timeoutMs,
      this.opts.exec,
    );
    const status = this.statusFor(outcome);
    if (status !== "ok") {
      return this.report(mp, [], 0, status);
    }
    const prev = this.baseline.get(mp.provider.id);
    this.baseline.set(mp.provider.id, toMultiset(outcome.diagnostics));
    if (!prev) {
      // No baseline (first touch, or the startup seed failed/timed out): report every
      // current diagnostic in the files the model just edited, then diff normally from
      // the baseline stored above. Silence here would hide type errors all session (#WS2.3).
      return this.report(
        mp,
        filterToFiles(outcome.diagnostics, files, this.opts.projectDir),
        0,
        "no_baseline",
      );
    }
    const newDiagnostics = computeNew(prev, outcome.diagnostics);
    const fixedCount = countFixed(prev, outcome.diagnostics);
    return this.report(mp, newDiagnostics, fixedCount, "ok");
  }

  private statusFor(outcome: RunOutcome): CheckStatus {
    if (!outcome.available) return "unavailable";
    if (outcome.timedOut) return "timeout";
    return "ok";
  }

  private report(
    mp: ManagerProvider,
    newDiagnostics: Diagnostic[],
    fixedCount: number,
    status: CheckStatus,
  ): CheckReport {
    const text = formatReport({
      providerId: mp.provider.id,
      status,
      newDiagnostics,
      fixedCount,
      maxReported: this.opts.maxReported,
      timeoutMs: this.opts.timeoutMs,
    });
    return {
      providerId: mp.provider.id,
      language: mp.provider.language,
      newDiagnostics,
      fixedCount,
      status,
      text,
    };
  }

  /** Serialize work per provider id so seed and checks never overlap. */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(
      () => fn(),
      () => fn(),
    );
    this.locks.set(id, next.then(noop, noop));
    return next;
  }
}

function noop(): void {}

/** Diagnostics whose file is one of the edited paths. Diagnostic.file is
 *  projectDir-relative when resolvable; inputs may be absolute or relative. */
function filterToFiles(
  diagnostics: Diagnostic[],
  files: string[],
  projectDir: string,
): Diagnostic[] {
  const wanted = new Set(files.map((f) => toRelative(projectDir, resolve(projectDir, f))));
  return diagnostics.filter((d) => wanted.has(d.file));
}
