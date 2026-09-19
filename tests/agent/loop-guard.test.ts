import { describe, expect, test } from "bun:test";
import {
  LoopGuard,
  RepeatedProbeGuard,
  repeatedProbeRecoveryAdvice,
  signatureOf,
} from "../../src/agent/loop-guard";
import { DEFAULT_LOOP_GUARD } from "../../src/config/loop-guard";

const cfg = DEFAULT_LOOP_GUARD;
const editCall = (path: string) => ({ name: "edit_file", args: { path } });
const bashCall = (command: string) => ({ name: "bash", args: { command } });
const todoCall = (titles: string[]) => ({
  name: "todo_write",
  args: { todos: titles.map((t) => ({ content: t, status: "pending" })) },
});
const readCall = (path: string) => ({ name: "read_file", args: { path } });

test("numbered diagnostic probes warn, then stop only after a second unchanged stretch", () => {
  const guard = new RepeatedProbeGuard(8);
  const observe = (n: number, value = '"after":"Copy install command"') =>
    guard.observe(
      { name: "bash", args: { command: `console.log('replay${n}:', result)` } },
      { ok: true, output: `replay${n}: {${value}}` },
    );
  for (let n = 1; n < 8; n++) expect(observe(n)).toBeNull();
  expect(observe(8)).toEqual({ kind: "warn", count: 8 });
  for (let n = 9; n < 16; n++) expect(observe(n)).toBeNull();
  expect(observe(16)).toEqual({ kind: "stop", count: 16 });
});

test("numbered diagnostic probes reset on a changed result or successful edit", () => {
  const guard = new RepeatedProbeGuard(8);
  const probe = (n: number, value: string) =>
    guard.observe(
      { name: "bash", args: { command: `console.log('replay${n}:', result)` } },
      { ok: true, output: `replay${n}: ${value}` },
    );
  for (let n = 1; n <= 7; n++) expect(probe(n, "unchanged")).toBeNull();
  expect(probe(8, "changed")).toBeNull();
  expect(
    guard.observe({ name: "edit_file", args: { path: "src/app.ts" } }, { ok: true }),
  ).toBeNull();
  for (let n = 9; n <= 15; n++) expect(probe(n, "changed")).toBeNull();
});

test("ordinary commands and changing probe values do not trigger the numbered probe guard", () => {
  const guard = new RepeatedProbeGuard(8);
  for (let n = 1; n <= 20; n++) {
    expect(
      guard.observe(
        { name: "bash", args: { command: `cat src/file${n}.ts` } },
        { ok: true, output: "same file content" },
      ),
    ).toBeNull();
    expect(
      guard.observe(
        { name: "bash", args: { command: `console.log('probe${n}:', result)` } },
        { ok: true, output: `probe${n}: value ${n}` },
      ),
    ).toBeNull();
  }
});

test("repeated probe advice identifies an event replay defect when the command shows one", () => {
  expect(repeatedProbeRecoveryAdvice("document.dispatchEvent(ev)")).toContain(
    "Save the original clicked element",
  );
  expect(repeatedProbeRecoveryAdvice("console.log(result)")).toContain("test assertion");
});

test("signatureOf keys edits by path and commands by normalized text; tracks reads", () => {
  expect(signatureOf("edit_file", { path: "/p/a.ts" })).toBe("edit:/p/a.ts");
  expect(signatureOf("write_file", { file_path: "/p/b.ts" })).toBe("edit:/p/b.ts");
  expect(signatureOf("bash", { command: "cargo  build" })).toBe("cmd:cargo build");
  expect(signatureOf("read_file", { path: "/p/a.ts" })).toBe("read:/p/a.ts");
  expect(signatureOf("glob", { pattern: "*" })).toBeNull();
  expect(signatureOf("edit_file", {})).toBeNull(); // no path → untracked
  expect(signatureOf("bash", {})).toBeNull(); // no command → untracked
});

test("signatureOf collapses path spellings to one signature", () => {
  const root = "/proj";
  expect(signatureOf("edit_file", { path: "src/a.ts" }, root)).toBe("edit:src/a.ts");
  expect(signatureOf("edit_file", { path: "./src/a.ts" }, root)).toBe("edit:src/a.ts");
  expect(signatureOf("edit_file", { path: "/proj/src/a.ts" }, root)).toBe("edit:src/a.ts");
});

test("signatureOf keeps absolute paths OUTSIDE the root distinct", () => {
  expect(signatureOf("edit_file", { path: "/etc/hosts" }, "/proj")).toBe("edit:/etc/hosts");
});

test("signatureOf without a root normalizes lexically only", () => {
  expect(signatureOf("read_file", { path: "./src/a.ts" })).toBe("read:src/a.ts");
  expect(signatureOf("read_file", { path: "/abs/a.ts" })).toBe("read:/abs/a.ts");
});

test("read/edit streak pairing matches across spellings", () => {
  // Default failRepeatThreshold (3): three DIFFERENT spellings of the same path must collapse
  // to ONE signature so the streak accumulates across them and warns on the 3rd — the very
  // first warning for this signature, so cooldown (set only once a warning fires) cannot yet
  // suppress it.
  const g = new LoopGuard(DEFAULT_LOOP_GUARD, "/proj");
  expect(g.observe({ name: "edit_file", args: { path: "./src/a.ts" } }, { ok: false })).toBeNull();
  expect(
    g.observe({ name: "edit_file", args: { path: "/proj/src/a.ts" } }, { ok: false }),
  ).toBeNull();
  const w = g.observe({ name: "edit_file", args: { path: "src/a.ts" } }, { ok: false });
  expect(w).toContain("edits to src/a.ts");
});

test("warns on the Nth edit of the same file, not before", () => {
  const g = new LoopGuard(cfg);
  for (let i = 0; i < cfg.editRepeatThreshold - 1; i++) {
    expect(g.observe(editCall("/p/Cargo.toml"), { ok: true })).toBeNull();
  }
  const w = g.observe(editCall("/p/Cargo.toml"), { ok: true });
  expect(w).toContain("Cargo.toml");
  expect(w).toContain(String(cfg.editRepeatThreshold));
});

test("interleaved edits to different files stay under threshold", () => {
  const g = new LoopGuard(cfg);
  for (let i = 0; i < 6; i++) {
    expect(g.observe(editCall(`/p/file${i}.ts`), { ok: true })).toBeNull();
  }
});

test("repeated reads of the same file warn at the no-progress threshold", () => {
  const g = new LoopGuard(cfg);
  let w: string | null = null;
  for (let i = 0; i < cfg.noProgressThreshold - 1; i++) {
    expect(g.observe(readCall("/p/a.ts"), { ok: true })).toBeNull();
  }
  w = g.observe(readCall("/p/a.ts"), { ok: true });
  expect(w).toContain("/p/a.ts");
  expect(w).toContain("without making progress");
});

test("warns on consecutive failing commands; a success in the window resets", () => {
  const g = new LoopGuard(cfg);
  expect(g.observe(bashCall("cargo build"), { ok: false })).toBeNull();
  expect(g.observe(bashCall("cargo build"), { ok: false })).toBeNull();
  expect(g.observe(bashCall("cargo build"), { ok: false })).toContain("cargo build");

  const g2 = new LoopGuard(cfg);
  g2.observe(bashCall("cargo build"), { ok: false });
  g2.observe(bashCall("cargo build"), { ok: true }); // progress
  // 3 repeats (< noProgressThreshold) with a success in the window: the fail rule does not fire.
  expect(g2.observe(bashCall("cargo build"), { ok: false })).toBeNull(); // not all-failed in window
});

test("cooldown suppresses re-warning the same signature", () => {
  const g = new LoopGuard(cfg);
  for (let i = 0; i < cfg.editRepeatThreshold; i++) g.observe(editCall("/p/a.ts"), { ok: true });
  // just warned; next `cooldown` edits to the same path do not warn
  for (let i = 0; i < cfg.cooldown; i++) {
    expect(g.observe(editCall("/p/a.ts"), { ok: true })).toBeNull();
  }
});

test("occurrences older than windowSize do not count", () => {
  const g = new LoopGuard({ ...cfg, windowSize: 4, editRepeatThreshold: 3 });
  g.observe(editCall("/p/a.ts"), { ok: true }); // window: [a]
  g.observe(editCall("/p/b.ts"), { ok: true });
  g.observe(editCall("/p/b.ts"), { ok: true });
  g.observe(editCall("/p/b.ts"), { ok: true }); // window now [a,b,b,b]; next push evicts a
  // a fresh single 'a' is alone in the window (the old 'a' evicted)
  expect(g.observe(editCall("/p/a.ts"), { ok: true })).toBeNull();
});

test("signatureOf now tracks reads and todo_write (normalized, status-independent)", () => {
  expect(signatureOf("read_file", { path: "/p/a.ts" })).toBe("read:/p/a.ts");
  // status is ignored; same content set → same signature
  const s1 = signatureOf("todo_write", {
    todos: [
      { content: "A", status: "pending" },
      { content: "B", status: "pending" },
    ],
  });
  const s2 = signatureOf("todo_write", {
    todos: [
      { content: "A", status: "in_progress" },
      { content: "B", status: "done" },
    ],
  });
  expect(s1).toBe(s2);
  expect(s1).toContain("todo:");
});

test("warns on repeated SUCCESSFUL no-op command (the cleetusdesk4 ls loop)", () => {
  const g = new LoopGuard(cfg);
  let w: string | null = null;
  for (let i = 0; i < cfg.noProgressThreshold; i++) {
    w = g.observe(bashCall("ls -la /proj"), { ok: true });
  }
  expect(w).toContain("ls -la /proj");
  expect(w).toContain("without making progress");
});

test("warns on repeated todo_write of the same plan (status churn ignored)", () => {
  const g = new LoopGuard(cfg);
  let w: string | null = null;
  for (let i = 0; i < cfg.noProgressThreshold; i++) {
    w = g.observe(todoCall(["Explore", "Plan", "Build"]), { ok: true });
  }
  expect(w).toContain("without making progress");
});

test("a real edit between repeats suppresses the stall warning", () => {
  const g = new LoopGuard(cfg);
  // ls, edit, ls, edit, ls, edit, ls — never 4 ls without an edit after the first
  const seq: Array<[ReturnType<typeof bashCall> | ReturnType<typeof editCall>, boolean]> = [];
  for (let i = 0; i < cfg.noProgressThreshold; i++) {
    seq.push([bashCall("ls -la /proj"), true]);
    seq.push([editCall("/proj/file.ts"), true]);
  }
  let w: string | null = null;
  for (const [call, ok] of seq) w = g.observe(call, { ok });
  expect(w).toBeNull();
});

test("distinct successful commands never reach the stall threshold", () => {
  const g = new LoopGuard(cfg);
  let w: string | null = null;
  for (let i = 0; i < cfg.noProgressThreshold + 2; i++) {
    w = g.observe(bashCall(`ls -la /proj/dir${i}`), { ok: true });
  }
  expect(w).toBeNull();
});

test("all-failed command still produces the fail message, not stall", () => {
  const g = new LoopGuard(cfg);
  let w: string | null = null;
  for (let i = 0; i < cfg.failRepeatThreshold; i++) {
    w = g.observe(bashCall("cargo build"), { ok: false });
  }
  expect(w).toContain("failed");
  expect(w).not.toContain("without making progress");
});

test("escape rule warns on the 2nd out-of-tree attempt across different targets", () => {
  const g = new LoopGuard(cfg);
  expect(g.observe(editCall("/outside/a.md"), { ok: false, outOfTree: true })).toBeNull();
  const w = g.observe(editCall("/elsewhere/b.md"), { ok: false, outOfTree: true });
  expect(w).toContain("outside the project root");
});

test("escape rule does not warn on a single out-of-tree attempt", () => {
  const g = new LoopGuard(cfg);
  expect(g.observe(editCall("/outside/a.md"), { ok: false, outOfTree: true })).toBeNull();
});

test("escape rule counts across in-tree calls interleaved between out-of-tree ones", () => {
  const g = new LoopGuard(cfg);
  expect(g.observe(editCall("/outside/a.md"), { ok: false, outOfTree: true })).toBeNull();
  expect(g.observe(bashCall("ls -la /proj"), { ok: true })).toBeNull(); // in-tree, not counted
  const w = g.observe(editCall("/outside/b.md"), { ok: false, outOfTree: true });
  expect(w).toContain("outside the project root");
});

test("escape rule respects cooldown before re-warning", () => {
  const g = new LoopGuard(cfg);
  g.observe(editCall("/outside/a.md"), { ok: false, outOfTree: true });
  expect(g.observe(editCall("/outside/b.md"), { ok: false, outOfTree: true })).toContain(
    "outside the project root",
  );
  // Immediately after warning, another out-of-tree attempt is suppressed by cooldown.
  expect(g.observe(editCall("/outside/c.md"), { ok: false, outOfTree: true })).toBeNull();
});

test("a normal in-tree session never triggers the escape warning", () => {
  const g = new LoopGuard(cfg);
  let w: string | null = null;
  for (let i = 0; i < 5; i++) w = g.observe(editCall(`/proj/f${i}.ts`), { ok: true });
  expect(w).toBeNull();
});

test("gate blocks a failing command after block_threshold warnings", () => {
  const g = new LoopGuard(cfg); // default blockThreshold 2, failRepeatThreshold 3
  // Not blocked before any warning has fired.
  expect(g.gate(bashCall("bun run build"))).toBeNull();
  // Drive failing repeats until two 'fail' warnings have accrued (cooldown spaces them out).
  let warns = 0;
  for (let i = 0; i < 40 && warns < cfg.blockThreshold; i++) {
    if (g.observe(bashCall("bun run build"), { ok: false })) warns++;
  }
  expect(warns).toBe(cfg.blockThreshold);
  const blocked = g.gate(bashCall("bun run build"));
  expect(blocked).toContain("<loop-block>");
  expect(blocked).toContain("bun run build");
});

test("a successful edit resets warn counts so the command is no longer blocked", () => {
  const g = new LoopGuard(cfg);
  let warns = 0;
  for (let i = 0; i < 40 && warns < cfg.blockThreshold; i++) {
    if (g.observe(bashCall("bun run build"), { ok: false })) warns++;
  }
  expect(g.gate(bashCall("bun run build"))).not.toBeNull(); // blocked now
  g.observe(editCall("/p/src/x.ts"), { ok: true }); // real progress
  expect(g.gate(bashCall("bun run build"))).toBeNull(); // reopened
});

test("edits are never blocked, regardless of repeat count", () => {
  const g = new LoopGuard(cfg);
  for (let i = 0; i < 20; i++) g.observe(editCall("/p/a.ts"), { ok: true });
  expect(g.gate(editCall("/p/a.ts"))).toBeNull();
});

test("block_threshold 0 disables the gate (warn-only preserved)", () => {
  const g = new LoopGuard({ ...cfg, blockThreshold: 0 });
  let warns = 0;
  for (let i = 0; i < 40 && warns < 3; i++) {
    if (g.observe(bashCall("bun run build"), { ok: false })) warns++;
  }
  expect(warns).toBeGreaterThan(0); // still warns
  expect(g.gate(bashCall("bun run build"))).toBeNull(); // but never blocks
});

test("fail rule is suppressed during a red -> edit(ok) -> red TDD loop", () => {
  const g = new LoopGuard(cfg);
  // run(red), edit(ok), run(red), edit(ok), run(red): the command reaches the fail threshold,
  // but a successful edit landed between the failures, so no warning should fire.
  expect(g.observe(bashCall("bun test"), { ok: false })).toBeNull();
  expect(g.observe(editCall("/p/a.test.ts"), { ok: true })).toBeNull();
  expect(g.observe(bashCall("bun test"), { ok: false })).toBeNull();
  expect(g.observe(editCall("/p/a.test.ts"), { ok: true })).toBeNull();
  expect(g.observe(bashCall("bun test"), { ok: false })).toBeNull(); // was a fail warning before
});

test("fail rule still warns when the command spins with no intervening edit", () => {
  const g = new LoopGuard(cfg);
  expect(g.observe(bashCall("bun test"), { ok: false })).toBeNull();
  expect(g.observe(bashCall("bun test"), { ok: false })).toBeNull();
  expect(g.observe(bashCall("bun test"), { ok: false })).toContain("bun test");
});

test("fail rule still warns when intervening edits themselves fail (no real change)", () => {
  const g = new LoopGuard(cfg);
  expect(g.observe(bashCall("bun test"), { ok: false })).toBeNull();
  expect(g.observe(editCall("/p/a.test.ts"), { ok: false })).toBeNull(); // failed edit
  expect(g.observe(bashCall("bun test"), { ok: false })).toBeNull();
  expect(g.observe(editCall("/p/a.test.ts"), { ok: false })).toBeNull(); // failed edit
  expect(g.observe(bashCall("bun test"), { ok: false })).toContain("bun test");
});

test("a successful edit BEFORE the run sequence does not suppress the fail warning", () => {
  const g = new LoopGuard(cfg);
  expect(g.observe(editCall("/p/a.test.ts"), { ok: true })).toBeNull(); // predates first run
  expect(g.observe(bashCall("bun test"), { ok: false })).toBeNull();
  expect(g.observe(bashCall("bun test"), { ok: false })).toBeNull();
  expect(g.observe(bashCall("bun test"), { ok: false })).toContain("bun test");
});

test("a genuinely stuck fail loop still escalates to a block", () => {
  const g = new LoopGuard(cfg);
  // No successful edits: two fail warnings accrue (past the cooldown), reaching blockThreshold.
  for (let i = 0; i < 10; i++) g.observe(bashCall("bun test"), { ok: false });
  expect(g.gate(bashCall("bun test"))).not.toBeNull();
});

test("stall rule still suppresses on any edit including a failed one (unchanged)", () => {
  const g = new LoopGuard(cfg);
  expect(g.observe(readCall("/p/a.ts"), { ok: true })).toBeNull();
  expect(g.observe(editCall("/p/x.ts"), { ok: false })).toBeNull(); // failed edit
  expect(g.observe(readCall("/p/a.ts"), { ok: true })).toBeNull();
  expect(g.observe(readCall("/p/a.ts"), { ok: true })).toBeNull();
  // 4th read reaches noProgressThreshold, but an edit (even a failed one) is in-window after the
  // first read, so the stall rule stays suppressed — proving the change did not leak into stall.
  expect(g.observe(readCall("/p/a.ts"), { ok: true })).toBeNull();
});

const failCmd = (g: LoopGuard) =>
  g.observe({ name: "bash", args: { command: "shadcn init" } }, { ok: false });
const passCmd = (g: LoopGuard) =>
  g.observe({ name: "bash", args: { command: "shadcn init" } }, { ok: true });
const okEdit = (g: LoopGuard) =>
  g.observe({ name: "write_file", args: { path: "a.ts" } }, { ok: true });

describe("LoopGuard editfail streak (WS6.2 amendment)", () => {
  test("editfail: 3 consecutive failed edits to the same path warn with re-read guidance", () => {
    const g = new LoopGuard(cfg);
    const call = editCall("src/a.ts");
    expect(g.observe(call, { ok: false })).toBeNull();
    expect(g.observe(call, { ok: false })).toBeNull();
    const warn = g.observe(call, { ok: false });
    expect(warn).toContain("edits to src/a.ts");
    expect(warn).toContain("read_file");
  });

  test("editfail: a successful edit of the same path clears the streak", () => {
    const g = new LoopGuard(cfg);
    const call = editCall("src/a.ts");
    g.observe(call, { ok: false });
    g.observe(call, { ok: false });
    g.observe(call, { ok: true }); // landed — streak gone
    expect(g.observe(call, { ok: false })).toBeNull(); // back to 1
  });

  test("editfail: re-reading the same path clears the streak (never bricked)", () => {
    const g = new LoopGuard(cfg);
    const edit = editCall("src/a.ts");
    g.observe(edit, { ok: false });
    g.observe(edit, { ok: false });
    g.observe(readCall("src/a.ts"), { ok: true });
    expect(g.observe(edit, { ok: false })).toBeNull(); // fresh streak
  });

  test("editfail: a successful edit of a DIFFERENT path does not clear the streak", () => {
    const g = new LoopGuard(cfg);
    const failing = editCall("src/a.ts");
    g.observe(failing, { ok: false });
    g.observe(failing, { ok: false });
    g.observe(editCall("src/b.ts"), { ok: true });
    expect(g.observe(failing, { ok: false })).not.toBeNull(); // 3rd consecutive fail → warns
  });

  test("editfail: gate refuses the edit at 5 consecutive failures and a read lifts it", () => {
    const g = new LoopGuard(cfg);
    const call = editCall("src/a.ts");
    for (let i = 0; i < 5; i++) g.observe(call, { ok: false });
    const block = g.gate(call);
    expect(block).toContain("refused");
    expect(block).toContain("read_file");
    g.observe(readCall("src/a.ts"), { ok: true });
    expect(g.gate(call)).toBeNull();
  });
});

describe("LoopGuard.thrashedSignature", () => {
  test("trips after `threshold` consecutive failures of one command", () => {
    const g = new LoopGuard(DEFAULT_LOOP_GUARD);
    failCmd(g);
    failCmd(g);
    failCmd(g);
    expect(g.thrashedSignature(4)).toBeNull();
    failCmd(g);
    expect(g.thrashedSignature(4)).toBe("cmd:shadcn init");
  });

  test("is edit-proof: successful edits between failures do not reset the streak", () => {
    const g = new LoopGuard(DEFAULT_LOOP_GUARD);
    for (let i = 0; i < 4; i++) {
      failCmd(g);
      okEdit(g); // #248 exemption would clear warnCount here — must NOT clear the streak
    }
    expect(g.thrashedSignature(4)).toBe("cmd:shadcn init");
  });

  test("a passing run of the command fully resets the streak", () => {
    const g = new LoopGuard(DEFAULT_LOOP_GUARD);
    failCmd(g);
    failCmd(g);
    passCmd(g); // red -> green
    failCmd(g);
    expect(g.thrashedSignature(4)).toBeNull();
  });

  test("threshold <= 0 disables (returns null even when a command keeps failing)", () => {
    const g = new LoopGuard(DEFAULT_LOOP_GUARD);
    for (let i = 0; i < 8; i++) failCmd(g);
    expect(g.thrashedSignature(0)).toBeNull();
  });

  test("non-command repeats never populate the streak", () => {
    const g = new LoopGuard(DEFAULT_LOOP_GUARD);
    for (let i = 0; i < 8; i++)
      g.observe({ name: "read_file", args: { path: "a.ts" } }, { ok: false });
    expect(g.thrashedSignature(1)).toBeNull();
  });
});

function hiddenCall(g: LoopGuard, name: string): string | null {
  return g.observe({ name, args: {} }, { ok: false, hiddenTool: true });
}

test("hidden-tool rule warns once at threshold across VARYING tool names", () => {
  const g = new LoopGuard({ ...DEFAULT_LOOP_GUARD, hiddenRepeatThreshold: 3 });
  expect(hiddenCall(g, "git_status")).toBeNull();
  expect(hiddenCall(g, "git_diff")).toBeNull();
  const w = hiddenCall(g, "git_log");
  expect(w).toContain("<loop-warning>");
  expect(w).toContain("not available in this session");
  // Cooldown: the very next hidden call does not re-warn.
  expect(hiddenCall(g, "git_status")).toBeNull();
});

test("hidden entries never trip the per-signature stall rule", () => {
  const g = new LoopGuard({
    ...DEFAULT_LOOP_GUARD,
    hiddenRepeatThreshold: 99,
    noProgressThreshold: 2,
  });
  hiddenCall(g, "git_status");
  const w = hiddenCall(g, "git_status");
  expect(w).toBeNull(); // would have been a "stall" warning if hidden entries reached it
});

test("hiddenRepeats counts hidden entries in the window", () => {
  const g = new LoopGuard({ ...DEFAULT_LOOP_GUARD, hiddenRepeatThreshold: 3 });
  hiddenCall(g, "git_status");
  g.observe({ name: "bash", args: { command: "ls" } }, { ok: true });
  hiddenCall(g, "smoke_run");
  expect(g.hiddenRepeats()).toBe(2);
});

test("successful real calls do not reset the hidden count", () => {
  const g = new LoopGuard({ ...DEFAULT_LOOP_GUARD, hiddenRepeatThreshold: 3 });
  hiddenCall(g, "git_status");
  g.observe({ name: "bash", args: { command: "ls" } }, { ok: true });
  hiddenCall(g, "git_diff");
  expect(hiddenCall(g, "git_log")).toContain("<loop-warning>");
});

test("hidden warning saturates at windowSize when the threshold exceeds it", () => {
  // The count is window-capped, so an unclamped threshold of 6 against a window of 4 could
  // never fire — the model would get no escalating warning before the (saturated) abort.
  const g = new LoopGuard({ ...DEFAULT_LOOP_GUARD, hiddenRepeatThreshold: 6, windowSize: 4 });
  expect(hiddenCall(g, "git_status")).toBeNull();
  expect(hiddenCall(g, "git_diff")).toBeNull();
  expect(hiddenCall(g, "git_log")).toBeNull();
  expect(hiddenCall(g, "git_show")).toContain("<loop-warning>");
});

test("a read under one spelling clears the edit-fail streak of another spelling", () => {
  const g = new LoopGuard(DEFAULT_LOOP_GUARD, "/proj");
  g.observe({ name: "edit_file", args: { path: "./src/a.ts" } }, { ok: false });
  g.observe({ name: "edit_file", args: { path: "src/a.ts" } }, { ok: false });
  // The corrective read uses the ABSOLUTE spelling; it must clear the streak the relative
  // spellings built — without the clear, the next failure would be the 3rd (= threshold)
  // and warn.
  g.observe({ name: "read_file", args: { path: "/proj/src/a.ts" } }, { ok: true });
  expect(g.observe({ name: "edit_file", args: { path: "src/a.ts" } }, { ok: false })).toBeNull();
});
