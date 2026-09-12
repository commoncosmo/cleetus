import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { signCommand } from "./build";

/** True if `dir` appears as a `:`-separated entry in the given PATH string. */
export function isOnPath(dir: string, pathEnv: string | undefined): boolean {
  return (pathEnv ?? "").split(":").includes(dir);
}

/** Copy the compiled binary into `targetDir` as an executable `cleetus`. Returns the dest path. */
export function installBinary(srcBinary: string, targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  const dest = join(targetDir, "cleetus");
  copyFileSync(srcBinary, dest);
  chmodSync(dest, 0o755);
  return dest;
}

/**
 * Re-sign the installed binary in place (ad-hoc). Copying a signed Mach-O invalidates its
 * signature at LAUNCH on macOS — the runtime code-signing monitor SIGKILLs it with
 * "Code Signature Invalid" — even though `codesign --verify` still passes statically. The
 * build signs `dist/`, but `installBinary` copies it onto the PATH, so the copy must be
 * re-signed at its destination. No-op off macOS. `run` is injectable for testing. Returns
 * true when a re-sign was performed.
 */
export function resignInPlace(
  dest: string,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => void = (cmd, args) =>
    execFileSync(cmd, args, { stdio: "inherit" }),
): boolean {
  if (platform !== "darwin") return false;
  run("codesign", signCommand(null, dest));
  return true;
}

if (import.meta.main) {
  const targetDir = join(homedir(), ".local", "bin");
  const dest = installBinary(join(process.cwd(), "dist", "cleetus"), targetDir);
  if (resignInPlace(dest)) console.log("re-signed (ad-hoc) for macOS");
  console.log(`installed ${dest}`);
  if (!isOnPath(targetDir, process.env.PATH)) {
    console.log(`\n${targetDir} is not on your PATH. Add this to your shell profile:`);
    console.log(`  export PATH="$HOME/.local/bin:$PATH"`);
  }
}
