import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type WindowsEnvironmentDeps,
  checkWindowsPrerequisites,
  environmentExitCode,
  formatEnvironmentReport,
  peArchitecture,
  projectToolChecks,
  windowsFirstRunPrerequisites,
} from "../../src/setup/windows-environment";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "cleetus-env-test-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const deps = (over: Partial<WindowsEnvironmentDeps> = {}): Partial<WindowsEnvironmentDeps> => ({
  platform: "win32",
  arch: "arm64",
  osRelease: "10.0.28000",
  executor: "C:/cleetus/native/wxc-exec.exe",
  which: (name) => (name === "pwsh.exe" ? "C:/PowerShell/pwsh.exe" : null),
  exists: () => true,
  architecture: () => "arm64",
  health: async () => null,
  shellVersion: async () => true,
  ...over,
});
it("optional tools warn without blocking a usable native environment", async () => {
  const report = await checkWindowsPrerequisites(".", "host", deps());
  expect(environmentExitCode(report)).toBe(0);
  expect(report.checks.find((c) => c.id === "git")?.status).toBe("warn");
  expect(report.checks.find((c) => c.id === "mxc-runtime")?.status).toBe("pass");
  expect(formatEnvironmentReport(report)).toContain("MXC is bundled");
});
it("reports an incomplete ZIP and skips the sandbox probe", async () => {
  let probes = 0;
  const report = await checkWindowsPrerequisites(
    ".",
    "host",
    deps({
      exists: () => false,
      health: async () => {
        probes++;
        return null;
      },
    }),
  );
  expect(environmentExitCode(report)).toBe(1);
  expect(probes).toBe(0);
  expect(report.checks.find((c) => c.id === "mxc-package")?.remedy).toContain(
    "No separate MXC installation",
  );
});
it("rejects mixed-architecture executors", async () => {
  const report = await checkWindowsPrerequisites(".", "host", deps({ architecture: () => "x64" }));
  expect(report.checks.find((c) => c.id === "mxc-package")?.status).toBe("fail");
});
it("missing pwsh explains that Windows PowerShell 5.1 is insufficient", async () => {
  const report = await checkWindowsPrerequisites(".", "host", deps({ which: () => null }));
  expect(environmentExitCode(report)).toBe(1);
  expect(report.checks.find((c) => c.id === "powershell")?.detail).toContain("5.1 is insufficient");
});
it("surfaces native capability failures without silently falling back", async () => {
  const report = await checkWindowsPrerequisites(
    ".",
    "host",
    deps({ health: async () => "ProcessContainer unavailable" }),
  );
  expect(environmentExitCode(report)).toBe(1);
  expect(report.checks.find((c) => c.id === "mxc-runtime")?.detail).toContain(
    "ProcessContainer unavailable",
  );
});
it("does not require native MXC or PowerShell for Docker", async () => {
  const report = await checkWindowsPrerequisites(
    ".",
    "docker",
    deps({ which: () => null, exists: () => false }),
  );
  expect(environmentExitCode(report)).toBe(0);
  expect(report.checks.find((c) => c.id === "mxc-runtime")?.status).toBe("skip");
});
it("explicit none still verifies the native PowerShell version", async () => {
  const report = await checkWindowsPrerequisites(
    ".",
    "none",
    deps({ shellVersion: async () => false }),
  );
  expect(environmentExitCode(report)).toBe(1);
});
it("rejects non-Windows hosts without running native probes", async () => {
  const report = await checkWindowsPrerequisites(".", "host", deps({ platform: "linux" }));
  expect(report.checks).toHaveLength(1);
  expect(environmentExitCode(report)).toBe(1);
});
it("first run stops before provider setup when prerequisites fail, using the supplied output channel", async () => {
  const failed = await checkWindowsPrerequisites(".", "host", deps({ exists: () => false }));
  let output = "";
  expect(
    await windowsFirstRunPrerequisites(
      ".",
      "host",
      (s) => {
        output += s;
      },
      "win32",
      async () => failed,
    ),
  ).toBe(false);
  expect(output).toContain("Re-extract");
  expect(
    await windowsFirstRunPrerequisites(
      ".",
      "host",
      () => {
        throw new Error("unexpected output");
      },
      "linux",
    ),
  ).toBe(true);
});
it("inspects PE headers without executing binaries and rejects malformed files", () => {
  const file = join(fixture(), "fake.exe");
  const data = Buffer.alloc(160);
  data.writeUInt16LE(0x5a4d, 0);
  data.writeUInt32LE(128, 0x3c);
  data.writeUInt32LE(0x4550, 128);
  data.writeUInt16LE(0xaa64, 132);
  writeFileSync(file, data);
  expect(peArchitecture(file)).toBe("arm64");
  writeFileSync(file, "not PE");
  expect(peArchitecture(file)).toBeNull();
});
it("recommends only project-relevant tools and never runs manifest scripts", async () => {
  const root = fixture();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ packageManager: "bun@1.3.14", scripts: { test: "must never execute" } }),
  );
  const checks = await projectToolChecks(root, () => null);
  expect(checks.map((c) => c.id)).toEqual(["project-bun"]);
  expect(checks[0]?.status).toBe("warn");
});
it("detects package managers and other root-level project markers", async () => {
  const root = fixture();
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "app.csproj",
  ])
    writeFileSync(join(root, name), name === "package.json" ? "{}" : "");
  const checks = await projectToolChecks(root, () => null);
  expect(checks.map((c) => c.id)).toEqual([
    "project-node",
    "project-pnpm",
    "project-python",
    "project-cargo",
    "project-go",
    "project-dotnet",
  ]);
  expect(checks.every((c) => c.requirement === "project" && c.status === "warn")).toBe(true);
});
it("does not mistake a Python Store alias for a verified interpreter", async () => {
  const root = fixture();
  writeFileSync(join(root, "requirements.txt"), "");
  const checks = await projectToolChecks(
    root,
    () => "C:/Users/u/AppData/Local/Microsoft/WindowsApps/python.exe",
  );
  expect(checks[0]?.status).toBe("warn");
  expect(checks[0]?.detail).toContain("Alias");
});
it("honors an explicit package manager over stale lockfiles", async () => {
  const root = fixture();
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10" }));
  writeFileSync(join(root, "bun.lock"), "");
  expect((await projectToolChecks(root, () => null)).map((c) => c.id)).toEqual([
    "project-node",
    "project-pnpm",
  ]);
});
