import { describe, expect, it } from "bun:test";
import { DiagnosticsManager } from "../../src/diagnostics/manager";
import type {
  Diagnostic,
  DiagnosticsProvider,
  ResolvedCmd,
  RunOutcome,
} from "../../src/diagnostics/types";

const CMD: ResolvedCmd = { command: "stub", baseArgs: [] };

/** A provider whose run() returns scripted outcomes in sequence. */
class StubProvider implements DiagnosticsProvider {
  id = "stub";
  language = "typescript" as const;
  calls = 0;
  constructor(private readonly outcomes: RunOutcome[]) {}
  matches(file: string): boolean {
    return file.endsWith(".ts");
  }
  async hasProjectMarker(): Promise<boolean> {
    return true;
  }
  async detect(): Promise<ResolvedCmd | null> {
    return CMD;
  }
  async run(): Promise<RunOutcome> {
    const i = Math.min(this.calls, this.outcomes.length - 1);
    this.calls++;
    return this.outcomes[i]!;
  }
}

/** Tracks max concurrent in-flight run() calls to prove serialization. */
class ConcurrencyProbeProvider implements DiagnosticsProvider {
  id = "probe";
  language = "typescript" as const;
  active = 0;
  maxActive = 0;
  matches(file: string): boolean {
    return file.endsWith(".ts");
  }
  async hasProjectMarker(): Promise<boolean> {
    return true;
  }
  async detect(): Promise<ResolvedCmd | null> {
    return CMD;
  }
  async run(): Promise<RunOutcome> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve(); // yield so overlap would be observable if it existed
    this.active--;
    return { diagnostics: [], timedOut: false, available: true };
  }
}

/** Rejects on the first run(), then succeeds. */
class RejectOnceProvider implements DiagnosticsProvider {
  id = "rejecter";
  language = "typescript" as const;
  calls = 0;
  matches(file: string): boolean {
    return file.endsWith(".ts");
  }
  async hasProjectMarker(): Promise<boolean> {
    return true;
  }
  async detect(): Promise<ResolvedCmd | null> {
    return CMD;
  }
  async run(): Promise<RunOutcome> {
    this.calls++;
    if (this.calls === 1) throw new Error("boom");
    return { diagnostics: [], timedOut: false, available: true };
  }
}

const diag = (over: Partial<Diagnostic>): Diagnostic => ({
  file: "src/a.ts",
  line: 10,
  severity: "error",
  code: "TS2304",
  message: "Cannot find name 'foo'",
  ...over,
});
const ok = (diagnostics: Diagnostic[]): RunOutcome => ({
  diagnostics,
  timedOut: false,
  available: true,
});

function mgr(provider: DiagnosticsProvider) {
  return new DiagnosticsManager({
    projectDir: "/proj",
    providers: [{ provider, cmd: CMD }],
    timeoutMs: 15000,
    maxReported: 10,
  });
}

/** A python-matching stub, distinct id/language, to prove per-provider dedup. */
class PyStub implements DiagnosticsProvider {
  id = "pystub";
  language = "python" as const;
  calls = 0;
  constructor(private readonly outcomes: RunOutcome[]) {}
  matches(file: string): boolean {
    return file.endsWith(".py");
  }
  async hasProjectMarker(): Promise<boolean> {
    return true;
  }
  async detect(): Promise<ResolvedCmd | null> {
    return CMD;
  }
  async run(): Promise<RunOutcome> {
    const i = Math.min(this.calls, this.outcomes.length - 1);
    this.calls++;
    return this.outcomes[i]!;
  }
}

/** Manager over two providers (ts + py) for batch/dedup tests. */
function mgr2(ts: DiagnosticsProvider, py: DiagnosticsProvider) {
  return new DiagnosticsManager({
    projectDir: "/proj",
    providers: [
      { provider: ts, cmd: CMD },
      { provider: py, cmd: CMD },
    ],
    timeoutMs: 15000,
    maxReported: 10,
  });
}

const ctrl = new AbortController();

describe("DiagnosticsManager", () => {
  it("first check with no baseline reports all diagnostics scoped to the edited file", async () => {
    const outcome = ok([
      diag({ file: "src/a.ts" }),
      diag({ file: "src/other.ts", message: "unrelated" }),
    ]);
    const m = mgr(new StubProvider([outcome, outcome]));
    const r = await m.check("src/a.ts", ctrl.signal);
    expect(r?.status).toBe("no_baseline");
    expect(r?.newDiagnostics).toHaveLength(1);
    expect(r?.newDiagnostics[0]!.file).toBe("src/a.ts");

    // Second check of the same provider now diffs against the stored baseline.
    const r2 = await m.check("src/a.ts", ctrl.signal);
    expect(r2?.status).toBe("ok");
    expect(r2?.newDiagnostics).toHaveLength(0);
  });

  it("after seeding, reports a newly introduced diagnostic", async () => {
    const m = mgr(
      new StubProvider([ok([]), ok([diag({})])]), // seed clean, then one error
    );
    await m.check("src/a.ts", ctrl.signal); // seeds (clean)
    const r = await m.check("src/a.ts", ctrl.signal);
    expect(r?.status).toBe("ok");
    expect(r?.newDiagnostics).toHaveLength(1);
    expect(r?.text).toContain("1 new diagnostics");
  });

  it("does not re-report a pre-existing diagnostic whose line shifted", async () => {
    const m = mgr(new StubProvider([ok([diag({ line: 10 })]), ok([diag({ line: 20 })])]));
    await m.check("src/a.ts", ctrl.signal); // seed with line 10
    const r = await m.check("src/a.ts", ctrl.signal); // same error, line 20
    expect(r?.newDiagnostics).toHaveLength(0);
    expect(r?.status).toBe("ok");
  });

  it("returns null for a file no provider matches", async () => {
    const m = mgr(new StubProvider([ok([])]));
    expect(await m.check("src/a.py", ctrl.signal)).toBeNull();
  });

  it("reports timeout status without throwing", async () => {
    const m = mgr(new StubProvider([{ diagnostics: [], timedOut: true, available: true }]));
    const r = await m.check("src/a.ts", ctrl.signal);
    expect(r?.status).toBe("timeout");
    expect(r?.text).toContain("timed out");
  });

  it("reports unavailable status when the binary fails to spawn", async () => {
    const m = mgr(new StubProvider([{ diagnostics: [], timedOut: false, available: false }]));
    const r = await m.check("src/a.ts", ctrl.signal);
    expect(r?.status).toBe("unavailable");
  });

  it("seed() establishes the baseline so the first real check diffs correctly", async () => {
    const stub = new StubProvider([ok([diag({})]), ok([diag({}), diag({ message: "new!" })])]);
    const m = mgr(stub);
    m.seed(ctrl.signal);
    await m.whenSeeded(); // test-only barrier
    const r = await m.check("src/a.ts", ctrl.signal);
    expect(r?.newDiagnostics).toHaveLength(1);
    expect(r?.newDiagnostics[0]!.message).toBe("new!");
  });

  it("serializes overlapping checks for the same provider", async () => {
    const probe = new ConcurrencyProbeProvider();
    const m = new DiagnosticsManager({
      projectDir: "/proj",
      providers: [{ provider: probe, cmd: CMD }],
      timeoutMs: 15000,
      maxReported: 10,
    });
    await Promise.all([
      m.check("a.ts", ctrl.signal),
      m.check("b.ts", ctrl.signal),
      m.check("c.ts", ctrl.signal),
    ]);
    expect(probe.maxActive).toBe(1); // never more than one run() in flight at once
  });

  it("counts fixed pre-existing diagnostics after they disappear", async () => {
    const m = mgr(new StubProvider([ok([diag({}), diag({ message: "bar" })]), ok([diag({})])]));
    await m.check("src/a.ts", ctrl.signal); // seed with two errors
    const r = await m.check("src/a.ts", ctrl.signal); // one removed
    expect(r?.fixedCount).toBe(1);
    expect(r?.newDiagnostics).toHaveLength(0);
  });

  it("a rejecting check does not poison the lock for the next check", async () => {
    const m = mgr(new RejectOnceProvider());
    await expect(m.check("src/a.ts", ctrl.signal)).rejects.toThrow("boom");
    // The next check still runs and seeds cleanly (lock chain not broken).
    const r = await m.check("src/a.ts", ctrl.signal);
    expect(r?.status).toBe("no_baseline");
  });
});

describe("DiagnosticsManager.checkFiles", () => {
  it("runs a single provider once for many same-language files", async () => {
    const stub = new StubProvider([ok([])]);
    const m = mgr(stub);
    const reports = await m.checkFiles(["a.ts", "b.ts", "c.ts"], ctrl.signal);
    expect(stub.calls).toBe(1); // one run for the whole step, not one per file
    expect(reports).toHaveLength(1);
  });

  it("runs one run per distinct provider for mixed-language files", async () => {
    const ts = new StubProvider([ok([])]);
    const py = new PyStub([ok([])]);
    const m = mgr2(ts, py);
    const reports = await m.checkFiles(["a.ts", "b.ts", "c.py"], ctrl.signal);
    expect(ts.calls).toBe(1);
    expect(py.calls).toBe(1);
    expect(reports).toHaveLength(2);
  });

  it("dedups providers and returns reports in first-seen order", async () => {
    const ts = new StubProvider([ok([])]);
    const py = new PyStub([ok([])]);
    const m = mgr2(ts, py);
    // py file appears first → py report first.
    const reports = await m.checkFiles(["a.py", "b.ts"], ctrl.signal);
    expect(reports.map((r) => r.providerId)).toEqual(["pystub", "stub"]);
  });

  it("ignores files no provider matches", async () => {
    const stub = new StubProvider([ok([])]);
    const m = mgr(stub);
    const reports = await m.checkFiles(["a.ts", "readme.md"], ctrl.signal);
    expect(stub.calls).toBe(1);
    expect(reports).toHaveLength(1);
  });

  it("preserves baseline-diff semantics across batch calls", async () => {
    const m = mgr(new StubProvider([ok([]), ok([diag({})])]));
    await m.checkFiles(["a.ts"], ctrl.signal); // seed clean
    const reports = await m.checkFiles(["a.ts"], ctrl.signal); // introduce one error
    expect(reports[0]!.status).toBe("ok");
    expect(reports[0]!.newDiagnostics).toHaveLength(1);
  });

  it("check() delegates to checkFiles: single report or null", async () => {
    const m = mgr(new StubProvider([ok([])]));
    const r = await m.check("a.ts", ctrl.signal);
    expect(r?.status).toBe("no_baseline");
    expect(await m.check("a.py", ctrl.signal)).toBeNull(); // no provider matches
  });

  it("no-baseline report includes diagnostics for an out-of-project edited file", async () => {
    // A provider run reports one diagnostic on an absolute, out-of-project file
    // (mirrors toRelative's raw-absolute fallback) and one on an in-project file.
    const outcome = ok([
      diag({ file: "/outside/x.ts" }),
      diag({ file: "src/a.ts", message: "unrelated" }),
    ]);
    const m = mgr(new StubProvider([outcome]));
    const r = await m.checkFiles(["/outside/x.ts"], ctrl.signal);
    expect(r[0]?.status).toBe("no_baseline");
    expect(r[0]?.newDiagnostics.map((d) => d.file)).toContain("/outside/x.ts");
  });
});
