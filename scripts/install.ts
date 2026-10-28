import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { signCommand } from "./build";
import { version } from "../package.json";

/** True if `dir` appears as a `:`-separated entry in the given PATH string. */
export function isOnPath(
  dir: string,
  pathEnv: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const entries = (pathEnv ?? "").split(platform === "win32" ? ";" : ":");
  return platform === "win32"
    ? entries.some((p) => p.toLowerCase() === dir.toLowerCase())
    : entries.includes(dir);
}

/** Copy the compiled binary into `targetDir` as an executable `cleetus`. Returns the dest path. */
export function installBinary(
  srcBinary: string,
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  mkdirSync(targetDir, { recursive: true });
  const dest = join(targetDir, platform === "win32" ? "cleetus.exe" : "cleetus");
  if (platform === "win32")
    cpSync(join(dirname(srcBinary), "native"), join(targetDir, "native"), { recursive: true });
  copyFileSync(srcBinary, dest);
  if (platform !== "win32") chmodSync(dest, 0o755);
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
  const targetDir =
    process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
          "Programs",
          "Cleetus",
          "bin",
        )
      : join(homedir(), ".local", "bin");
  const ownWindowsPrefix =
    process.platform === "win32" &&
    (!existsSync(targetDir) || existsSync(join(targetDir, ".cleetus-install.json")));
  const dest = installBinary(
    join(process.cwd(), "dist", process.platform === "win32" ? "cleetus.exe" : "cleetus"),
    targetDir,
  );
  if (ownWindowsPrefix) {
    // This entry point owns the dedicated Programs/Cleetus/bin prefix. The
    // generic installBinary helper never claims ownership of a shared bin dir.
    writeFileSync(
      join(targetDir, ".cleetus-install.json"),
      JSON.stringify({ schema: 1, version: `v${version}`, architecture: process.arch }),
    );
  }
  if (resignInPlace(dest)) console.log("re-signed (ad-hoc) for macOS");
  console.log(`installed ${dest}`);
  if (!isOnPath(targetDir, process.env.PATH)) {
    console.log(`\n${targetDir} is not on your PATH. Add this to your shell profile:`);
    console.log(
      process.platform === "win32"
        ? `  $env:Path += ';${targetDir}'`
        : `  export PATH="$HOME/.local/bin:$PATH"`,
    );
  }
}
