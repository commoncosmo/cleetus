import { expect, test } from "bun:test";
import { type GitRunner, lastUserRequest, resolveSubject } from "../../src/agent/review";

function gitStub(map: Record<string, { exitCode: number; stdout: string }>): GitRunner {
  // The repo gate passes by default so diff-oriented tests read naturally; override to test non-repo.
  const full: Record<string, { exitCode: number; stdout: string }> = {
    "rev-parse --is-inside-work-tree": { exitCode: 0, stdout: "true\n" },
    ...map,
  };
  return async (argv) => {
    const key = argv.join(" ");
    const hit = full[key] ?? { exitCode: 0, stdout: "" };
    return { exitCode: hit.exitCode, stdout: hit.stdout, stderr: "" };
  };
}

test("no args → diff vs HEAD", async () => {
  const git = gitStub({ "diff HEAD": { exitCode: 0, stdout: "diff --git a/x.ts b/x.ts\n+1" } });
  const s = await resolveSubject(git, []);
  expect(s?.kind).toBe("diff");
  expect(s?.label).toBe("working-tree diff");
  expect(s?.diff).toContain("a/x.ts");
});

test("empty diff → null (nothing to review)", async () => {
  const git = gitStub({ "diff HEAD": { exitCode: 0, stdout: "   \n" } });
  expect(await resolveSubject(git, [])).toBeNull();
});

test("single arg that resolves as a ref → diff vs that ref", async () => {
  const git = gitStub({
    "rev-parse --verify --quiet HEAD~3^{commit}": { exitCode: 0, stdout: "abc123\n" },
    "diff HEAD~3": { exitCode: 0, stdout: "diff --git a/y.ts b/y.ts\n+2" },
  });
  const s = await resolveSubject(git, ["HEAD~3"]);
  expect(s?.label).toBe("diff vs HEAD~3");
  expect(s?.diff).toContain("y.ts");
});

test("args that are not refs → treated as paths", async () => {
  const git = gitStub({
    "rev-parse --verify --quiet src/a.ts^{commit}": { exitCode: 1, stdout: "" },
    "diff -- src/a.ts": { exitCode: 0, stdout: "diff --git a/src/a.ts b/src/a.ts\n+3" },
  });
  const s = await resolveSubject(git, ["src/a.ts"]);
  expect(s?.label).toContain("src/a.ts");
  expect(s?.diff).toContain("src/a.ts");
});

test("`all` → codebase subject, without running git", async () => {
  const git: GitRunner = async () => {
    throw new Error("git must not run for /review all");
  };
  const s = await resolveSubject(git, ["all"]);
  expect(s).toEqual({ kind: "codebase", diff: "", files: [], label: "the entire codebase" });
});

test("`all` is case-insensitive", async () => {
  const git: GitRunner = async () => {
    throw new Error("git must not run for /review all");
  };
  expect((await resolveSubject(git, ["ALL"]))?.kind).toBe("codebase");
});

test("not a git repository → null (caller suggests /review all)", async () => {
  const git = gitStub({ "rev-parse --is-inside-work-tree": { exitCode: 128, stdout: "" } });
  expect(await resolveSubject(git, [])).toBeNull();
});

test("lastUserRequest returns the most recent user message", () => {
  const msgs = [
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "make x faster" },
  ];
  expect(lastUserRequest(msgs)).toBe("make x faster");
  expect(lastUserRequest([])).toBeUndefined();
});

test("a git error on the diff (in a repo) throws, not masked as no-changes", async () => {
  const git: GitRunner = async (argv) => {
    if (argv.join(" ") === "rev-parse --is-inside-work-tree")
      return { exitCode: 0, stdout: "true", stderr: "" };
    return { exitCode: 128, stdout: "", stderr: "fatal: bad revision" };
  };
  await expect(resolveSubject(git, [])).rejects.toThrow("fatal: bad revision");
});

test("a git diff error with empty stderr throws a descriptive fallback", async () => {
  const git: GitRunner = async (argv) => {
    if (argv.join(" ") === "rev-parse --is-inside-work-tree")
      return { exitCode: 0, stdout: "true", stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  await expect(resolveSubject(git, [])).rejects.toThrow("git diff HEAD failed (exit 1)");
});
