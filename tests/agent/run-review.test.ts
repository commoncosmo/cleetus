import { expect, test } from "bun:test";
import { type GitRunner, runReview } from "../../src/agent/review";

const okGit =
  (stdout: string): GitRunner =>
  async (argv) => {
    if (argv.join(" ") === "rev-parse --is-inside-work-tree") {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    return { exitCode: 0, stdout, stderr: "" };
  };

test("no diff → prints the /review all suggestion, never spawns, never emits", async () => {
  let spawned = false;
  let emitted = false;
  const out: string[] = [];
  await runReview(
    [],
    {
      git: okGit("  \n"),
      spawn: async () => {
        spawned = true;
        return "x";
      },
      emitFindings: () => {
        emitted = true;
      },
      signal: new AbortController().signal,
    },
    (s) => out.push(s),
  );
  expect(spawned).toBe(false);
  expect(emitted).toBe(false);
  expect(out.join("\n")).toContain("Run `/review all` to review the entire codebase.");
});

test("non-empty diff spawns the reviewer and emits formatted findings (not print)", async () => {
  const out: string[] = [];
  const emitted: string[] = [];
  let seenPrompt = "";
  await runReview(
    [],
    {
      git: okGit("diff --git a/x.ts b/x.ts\n+bad"),
      intent: "add validation",
      spawn: async (prompt) => {
        seenPrompt = prompt;
        return "[Minor] x.ts:1 — nit.\n  verified: no (static).";
      },
      emitFindings: (md) => emitted.push(md),
      signal: new AbortController().signal,
    },
    (s) => out.push(s),
  );
  expect(seenPrompt).toContain("diff --git a/x.ts");
  expect(seenPrompt).toContain("add validation");
  // findings go through emitFindings as plan-style markdown, NOT through print
  expect(emitted.join("\n")).toContain("**R1** · ⚪ Minor · `x.ts:1`");
  expect(emitted.join("\n")).toContain("## Review — 1 finding");
  expect(out.join("\n")).not.toContain("x.ts:1");
});

test("a spawn failure still prints 'review failed' and does not emit", async () => {
  const out: string[] = [];
  let emitted = false;
  await runReview(
    [],
    {
      git: okGit("diff --git a/x.ts b/x.ts\n+bad"),
      spawn: async () => {
        throw new Error("boom");
      },
      emitFindings: () => {
        emitted = true;
      },
      signal: new AbortController().signal,
    },
    (s) => out.push(s),
  );
  expect(emitted).toBe(false);
  expect(out.join("\n")).toContain("review failed: boom");
});
