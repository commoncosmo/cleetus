import { describe, expect, test } from "bun:test";
import { formatStatus, parseDefaultBranch, parseStatus } from "../../src/git/parse";

describe("parseStatus", () => {
  test("clean tree on a branch", () => {
    const s = parseStatus("## main...origin/main\n");
    expect(s).toMatchObject({ branch: "main", ahead: 0, behind: 0 });
    expect(s.staged).toEqual([]);
    expect(s.unstaged).toEqual([]);
    expect(s.untracked).toEqual([]);
  });

  test("ahead/behind from the branch header", () => {
    const s = parseStatus("## feat/x...origin/feat/x [ahead 2, behind 1]\n");
    expect(s).toMatchObject({ branch: "feat/x", ahead: 2, behind: 1 });
  });

  test("staged, unstaged, and untracked entries", () => {
    const s = parseStatus(
      ["## main", "A  src/a.ts", " M src/b.ts", "MM src/c.ts", "?? notes.txt"].join("\n"),
    );
    expect(s.staged).toEqual([
      { path: "src/a.ts", label: "added" },
      { path: "src/c.ts", label: "modified" },
    ]);
    expect(s.unstaged).toEqual([
      { path: "src/b.ts", label: "modified" },
      { path: "src/c.ts", label: "modified" },
    ]);
    expect(s.untracked).toEqual(["notes.txt"]);
  });

  test("renames report the new path", () => {
    const s = parseStatus("## main\nR  old.ts -> new.ts\n");
    expect(s.staged).toEqual([{ path: "new.ts", label: "renamed" }]);
  });

  test("a fresh repo with no commits still yields the branch name", () => {
    const s = parseStatus("## No commits yet on main\n");
    expect(s.branch).toBe("main");
  });
});

describe("formatStatus", () => {
  test("clean tree", () => {
    expect(formatStatus(parseStatus("## main...origin/main\n"))).toBe(
      "working tree clean (branch main)",
    );
  });

  test("dirty tree renders sectioned summary", () => {
    const out = formatStatus(
      parseStatus(
        ["## feat/x...origin/feat/x [ahead 1, behind 0]", "A  a.ts", " M b.ts", "?? c.txt"].join(
          "\n",
        ),
      ),
    );
    expect(out).toBe(
      [
        "branch: feat/x (ahead 1, behind 0)",
        "staged:    a.ts (added)",
        "unstaged:  b.ts (modified)",
        "untracked: c.txt",
      ].join("\n"),
    );
  });
});

describe("parseDefaultBranch", () => {
  test("strips the remote ref prefix", () => {
    expect(parseDefaultBranch("refs/remotes/origin/main\n")).toBe("main");
    expect(parseDefaultBranch("origin/develop")).toBe("develop");
  });
  test("empty input is null", () => {
    expect(parseDefaultBranch("  \n")).toBeNull();
  });
});
