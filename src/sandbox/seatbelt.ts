import type { SandboxPolicy } from "./policy";

/** Quote a path as an SBPL string literal, escaping backslashes then double-quotes. */
function q(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Standard character devices that must stay writable even under deny-by-default writes.
 * `/dev/null` is load-bearing: `2>/dev/null` redirects and any subprocess using
 * `Stdio::null()` / `subprocess.DEVNULL` (e.g. cargo/rustix build scripts) open it for
 * write. We allow a curated literal list rather than `(subpath "/dev")` so raw block
 * devices stay denied. These device nodes get the precise `file-write-data` op (the
 * open-for-write + write path); `/dev/fd` (an fd-passthrough directory) gets the broader
 * `file-write*` since reopening an inherited fd can touch metadata-class ops.
 */
const SAFE_WRITE_DEVICES = [
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
  "/dev/dtracehelper",
  "/dev/stdout",
  "/dev/stderr",
];

/**
 * Build a deny-by-default-write SBPL profile and return the `sandbox-exec -p <profile>`
 * argv prefix that wraps a command. Reads/exec stay broad (`allow default`); writes are
 * confined to projectDir + writableExtra (plus standard safe `/dev` character devices);
 * secret paths are read-denied; network is denied only when the policy disables it.
 */
export function seatbeltPrefix(projectDir: string, policy: SandboxPolicy): string[] {
  const writeSubpaths = [projectDir, ...policy.writableExtra]
    .map((p) => `(subpath ${q(p)})`)
    .join(" ");
  const deviceLiterals = SAFE_WRITE_DEVICES.map((d) => `(literal ${q(d)})`).join(" ");
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writeSubpaths})`,
    // Standard safe character devices (notably /dev/null). /dev/fd is a directory.
    `(allow file-write-data ${deviceLiterals})`,
    '(allow file-write* (subpath "/dev/fd"))',
  ];
  // Last-match-wins: these per-exec denies follow the broad project allow so model-authored Bash
  // cannot erase its own audit trail or the user's repository metadata.
  for (const path of policy.protectedProjectPaths ?? []) {
    lines.push(`(deny file-write* (subpath ${q(`${projectDir}/${path}`)}))`);
  }
  for (const b of [...policy.blockedDirs, ...policy.blockedFiles]) {
    lines.push(`(deny file-read* (subpath ${q(b)}))`);
  }
  if (!policy.network) lines.push("(deny network*)");
  return ["sandbox-exec", "-p", lines.join("\n")];
}
