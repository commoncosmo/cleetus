import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CLEETUS_SANDBOX_ACTIVE_ENV, HostSandbox } from "../../src/sandbox/host";
import { buildPolicy } from "../../src/sandbox/policy";
import { seatbeltPrefix } from "../../src/sandbox/seatbelt";

const sig = () => new AbortController().signal;
// Real `sandbox-exec` enforcement; macOS only. It cannot produce meaningful evidence when the
// whole test runner is already inside Cleetus's host sandbox: the outer jail preempts both the
// "allowed" checks and the deliberately unsandboxed baseline write.
const nestedHostSandbox =
  process.env[CLEETUS_SANDBOX_ACTIVE_ENV] === "host" || process.env.CODEX_SANDBOX === "seatbelt";
const canExerciseSeatbelt = process.platform === "darwin" && !nestedHostSandbox;
const onDarwin = canExerciseSeatbelt ? describe : describe.skip;

// A HOME-root path that is writable WITHOUT the sandbox (proves the sandbox — not perms —
// is what blocks the write). HOME root is not in writableExtra (only $HOME/.npm etc.).
const escapeFile = join(homedir(), "cleetus-sandbox-escape-test.txt");

onDarwin(
  nestedHostSandbox
    ? "HostSandbox + seatbelt enforcement (nested host sandbox; run outside Cleetus)"
    : "HostSandbox + seatbelt enforcement",
  () => {
    let dir: string;
    beforeEach(async () => {
      dir = await realpath(await mkdtemp(join(tmpdir(), "cleetus-sb-")));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
      if (existsSync(escapeFile)) rmSync(escapeFile); // defensive; should never exist if denied
    });

    const sb = () => new HostSandbox(dir, buildPolicy(process.env, true), seatbeltPrefix);

    it("allows writes inside the project dir", async () => {
      const r = await sb().exec("echo hi > inproj.txt && cat inproj.txt", { signal: sig() });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hi");
    });

    it("allows writes/redirects to /dev/null (build scripts, 2>/dev/null)", async () => {
      // Regression: the deny-by-default for writes previously blocked /dev/null too,
      // breaking `2>/dev/null` and any Stdio::null() subprocess (e.g. cargo build scripts).
      // Success is gated on the /dev/null write itself: if it's denied, `&&` short-circuits,
      // "ok" is never printed, and the exit code is non-zero.
      const r = await sb().exec("ls /nonexistent 2>/dev/null; echo hi > /dev/null && echo ok", {
        signal: sig(),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("ok");
    });

    it("denies writes outside the project dir", async () => {
      // First prove the path IS writable without the sandbox, so a denial below is
      // unambiguously the sandbox's doing (not a pre-existing permission error).
      writeFileSync(escapeFile, "baseline");
      expect(existsSync(escapeFile)).toBe(true);
      rmSync(escapeFile);

      const quoted = `'${escapeFile.replace(/'/g, "'\\''")}'`;
      const r = await sb().exec(`echo nope > ${quoted}`, { signal: sig() });
      expect(r.exitCode).not.toBe(0);
      expect(existsSync(escapeFile)).toBe(false);
    });

    it("keeps source writable while denying model-authored Bash writes to .git and .cleetus", async () => {
      await mkdir(join(dir, ".git"), { recursive: true });
      await mkdir(join(dir, ".cleetus"), { recursive: true });
      await writeFile(join(dir, ".git", "config"), "original-git");
      await writeFile(join(dir, ".cleetus", "sessions.db"), "original-session");

      const r = await sb().exec(
        "echo source > app.ts; echo bad > .git/config; echo bad > .cleetus/sessions.db",
        { signal: sig(), protectProjectMetadata: true },
      );
      expect(r.exitCode).not.toBe(0);
      expect(await Bun.file(join(dir, "app.ts")).text()).toBe("source\n");
      expect(await Bun.file(join(dir, ".git", "config")).text()).toBe("original-git");
      expect(await Bun.file(join(dir, ".cleetus", "sessions.db")).text()).toBe("original-session");
    });
  },
);
