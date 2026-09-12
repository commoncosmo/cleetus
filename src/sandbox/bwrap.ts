import { existsSync } from "node:fs";
import type { SandboxPolicy } from "./policy";

/**
 * Build the `bwrap` argv prefix that wraps a command. A read-only host root is overlaid
 * with: fresh /dev and /proc, a read-write bind of projectDir + each existing writable
 * dir, an empty tmpfs over each secret dir, and /dev/null over each secret file. Network
 * is unshared only when the policy disables it.
 *
 * Process-tree containment: `--die-with-parent` kills the direct `bash` child when
 * cleetus exits, and `--unshare-pid` places `bash` in a fresh PID namespace where it
 * becomes PID 1 — so the kernel reaps the entire subtree when that namespace collapses.
 * Together they close the in-sandbox process-leak gap that the Docker backend documents
 * as a known limitation (Docker `--die-with-parent` alone does not kill grandchildren).
 */
export function bwrapPrefix(
  projectDir: string,
  policy: SandboxPolicy,
  exists: (p: string) => boolean = (p) => existsSync(p),
): string[] {
  const argv = [
    "bwrap",
    "--die-with-parent",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    // projectDir is the caller's cwd and is guaranteed to exist — no exists() gate needed.
    "--bind",
    projectDir,
    projectDir,
  ];
  for (const w of policy.writableExtra) {
    if (exists(w)) argv.push("--bind", w, w);
  }
  for (const path of policy.protectedProjectPaths ?? []) {
    const protectedPath = `${projectDir}/${path}`;
    if (exists(protectedPath)) argv.push("--ro-bind", protectedPath, protectedPath);
  }
  for (const d of policy.blockedDirs) {
    if (exists(d)) argv.push("--tmpfs", d);
  }
  for (const f of policy.blockedFiles) {
    if (exists(f)) argv.push("--ro-bind", "/dev/null", f);
  }
  if (!policy.network) argv.push("--unshare-net");
  argv.push("--");
  return argv;
}
