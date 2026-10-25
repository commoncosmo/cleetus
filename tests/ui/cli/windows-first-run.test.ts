import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.skipIf(process.platform !== "win32")(
  "first run stops before provider discovery/config writes when PowerShell is missing",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-first-run-prereqs-"));
    roots.push(root);
    const configDir = join(root, "config");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
    );
    const proc = Bun.spawn(
      [process.execPath, resolve("src/bin/cleetus.ts"), "--config-dir", configDir],
      {
        cwd: root,
        env: { ...env, PATH: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("PowerShell 7.4+");
    expect(stderr).toContain("winget install");
    expect(stdout).toBe("");
    expect(existsSync(join(configDir, "config.yaml"))).toBe(false);
  },
);
