export interface GitFileChange {
  path: string;
  label: string;
}

export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
}

const LABELS: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
  T: "type-changed",
};

function parseBranchLine(line: string, status: GitStatus): void {
  const noCommits = line.match(/^No commits yet on (.+)$/);
  const work = noCommits?.[1] ?? line;
  const ahead = work.match(/ahead (\d+)/)?.[1];
  const behind = work.match(/behind (\d+)/)?.[1];
  if (ahead !== undefined) status.ahead = Number(ahead);
  if (behind !== undefined) status.behind = Number(behind);
  const name = work.split(/\.\.\.| \[/)[0]?.trim() ?? "";
  status.branch = name || null;
}

/** Parse `git status --porcelain=v1 --branch` output into a structured status. */
export function parseStatus(porcelain: string): GitStatus {
  const status: GitStatus = {
    branch: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
  };
  for (const raw of porcelain.split("\n")) {
    if (!raw) continue;
    if (raw.startsWith("## ")) {
      parseBranchLine(raw.slice(3), status);
      continue;
    }
    const x = raw[0];
    const y = raw[1];
    const rest = raw.slice(3);
    if (x === "?" && y === "?") {
      status.untracked.push(rest);
      continue;
    }
    const path = rest.includes(" -> ") ? (rest.split(" -> ")[1] ?? rest) : rest;
    if (x && x !== " " && x !== "?") status.staged.push({ path, label: LABELS[x] ?? x });
    if (y && y !== " " && y !== "?") status.unstaged.push({ path, label: LABELS[y] ?? y });
  }
  return status;
}

function renderChanges(changes: GitFileChange[]): string {
  return changes.map((c) => `${c.path} (${c.label})`).join(", ");
}

/** Render a GitStatus into the model-facing summary. */
export function formatStatus(s: GitStatus): string {
  const branch = s.branch ?? "(detached)";
  const clean = !s.staged.length && !s.unstaged.length && !s.untracked.length;
  if (clean) return `working tree clean (branch ${branch})`;
  const lines = [`branch: ${branch} (ahead ${s.ahead}, behind ${s.behind})`];
  if (s.staged.length) lines.push(`staged:    ${renderChanges(s.staged)}`);
  if (s.unstaged.length) lines.push(`unstaged:  ${renderChanges(s.unstaged)}`);
  if (s.untracked.length) lines.push(`untracked: ${s.untracked.join(", ")}`);
  return lines.join("\n");
}

/** Strip a `refs/remotes/origin/` or `origin/` prefix from a default-branch ref. */
export function parseDefaultBranch(stdout: string): string | null {
  const t = stdout.trim();
  if (!t) return null;
  return t.replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "");
}
