import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import type { SandboxConfig } from "../config/types";
import { powershellArgs } from "../sandbox/shell";
import { spawnCollect } from "../sandbox/spawn";
import { WindowsSandbox, windowsExecutorPath } from "../sandbox/windows";

export interface EnvironmentCheck {
  id: string;
  label: string;
  requirement: "required" | "recommended" | "project";
  status: "pass" | "warn" | "fail" | "skip";
  detail: string;
  remedy?: string;
}
export interface EnvironmentReport {
  platform: string;
  architecture: string;
  checks: EnvironmentCheck[];
}
export function environmentExitCode(report: EnvironmentReport): number {
  return report.checks.some((c) => c.status === "fail") ? 1 : 0;
}
export function formatEnvironmentReport(report: EnvironmentReport): string {
  const lines = [
    `Windows environment (${report.architecture})`,
    ...report.checks.map(
      (c) =>
        `${c.status.toUpperCase().padEnd(4)} [${c.requirement}] ${c.label}: ${c.detail}${c.remedy ? `\n     ${c.remedy}` : ""}`,
    ),
    "MXC is bundled with Cleetus. Nothing is installed or reconfigured by this check.",
  ];
  return `${lines.join("\n")}\n`;
}

/** Inspect the PE machine field, without executing the binary. */
export function peArchitecture(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const data = Buffer.alloc(64);
    if (readSync(fd, data, 0, 64, 0) !== 64 || data.readUInt16LE(0) !== 0x5a4d) return null;
    const offset = data.readUInt32LE(0x3c);
    const header = Buffer.alloc(6);
    if (readSync(fd, header, 0, 6, offset) !== 6 || header.readUInt32LE(0) !== 0x4550) return null;
    return (
      ({ 43620: "arm64", 34404: "x64", 332: "ia32" } as Record<number, string>)[
        header.readUInt16LE(4)
      ] ?? "unknown"
    );
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export interface WindowsEnvironmentDeps {
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  executor: string;
  which: (name: string) => string | null;
  exists: (path: string) => boolean;
  architecture: (path: string) => string | null;
  health: (cwd: string, executor: string, powershell: string) => Promise<string | null>;
  shellVersion: (powershell: string) => Promise<boolean>;
}
function defaultDeps(): WindowsEnvironmentDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    executor: windowsExecutorPath(),
    which: Bun.which,
    exists: existsSync,
    architecture: peArchitecture,
    health: async (cwd, executor, powershell) => {
      const sandbox = new WindowsSandbox(cwd, false, executor, powershell);
      try {
        return await sandbox.healthCheck();
      } finally {
        await sandbox.dispose();
      }
    },
    shellVersion: async (powershell) => {
      const r = await spawnCollect(
        [
          powershell,
          ...powershellArgs("if ($PSVersionTable.PSVersion -lt [version]'7.4') { exit 1 }"),
        ],
        { signal: new AbortController().signal, timeoutMs: 5000 },
      );
      return r.exitCode === 0 && !r.timedOut;
    },
  };
}

export async function checkWindowsPrerequisites(
  cwd: string,
  backend: SandboxConfig["backend"] = "host",
  overrides: Partial<WindowsEnvironmentDeps> = {},
): Promise<EnvironmentReport> {
  const d = { ...defaultDeps(), ...overrides };
  const checks: EnvironmentCheck[] = [];
  const report = { platform: d.platform, architecture: d.arch, checks };
  if (d.platform !== "win32") {
    checks.push({
      id: "platform",
      label: "Windows",
      requirement: "required",
      status: "fail",
      detail: `This doctor requires native Windows; current platform is ${d.platform}.`,
    });
    return report;
  }
  checks.push({
    id: "platform",
    label: "Windows",
    requirement: "required",
    status: "pass",
    detail: `${d.osRelease}; actual MXC capability is probed rather than inferred from a build number.`,
  });
  const pwsh = d.which("pwsh.exe");
  const needsShell = backend !== "docker";
  if (pwsh && /[\\/]WindowsApps[\\/]/i.test(pwsh)) {
    checks.push({
      id: "powershell-packaging",
      label: "PowerShell packaging",
      requirement: backend === "host" ? "required" : "recommended",
      status: backend === "host" ? "fail" : "warn",
      detail:
        backend === "host"
          ? "The selected PowerShell resolves through WindowsApps/MSIX, which cannot run inside native MXC. An unpackaged PowerShell installation is required for this backend."
          : "The selected PowerShell resolves through WindowsApps/MSIX. Native MXC requires an unpackaged installation; the selected backend does not require MXC.",
      remedy:
        "Install an unpackaged PowerShell MSI or ZIP alongside the Store version and put its pwsh.exe first on PATH. MSI: winget install --id Microsoft.PowerShell --exact --source winget --installer-type wix",
    });
  }
  checks.push({
    id: "powershell",
    label: "PowerShell 7.4+",
    requirement: needsShell ? "required" : "recommended",
    status: pwsh ? "pass" : needsShell ? "fail" : "warn",
    detail: pwsh ?? "pwsh.exe was not found on PATH; Windows PowerShell 5.1 is insufficient.",
    ...(!pwsh
      ? {
          remedy:
            "Install PowerShell 7: winget install --id Microsoft.PowerShell --exact --source winget; then open a new terminal.",
        }
      : {}),
  });
  if (backend === "host") {
    const present = d.exists(d.executor);
    const arch = present ? d.architecture(d.executor) : null;
    const valid = present && arch === d.arch;
    checks.push({
      id: "mxc-package",
      label: "Bundled MXC executor",
      requirement: "required",
      status: valid ? "pass" : "fail",
      detail: !present
        ? `Missing ${d.executor}`
        : !valid
          ? `Expected ${d.arch} PE executable; found ${arch ?? "invalid executable"}.`
          : `${d.executor} (${arch})`,
      ...(!valid
        ? {
            remedy:
              "Re-extract the matching Cleetus Windows ZIP, keeping native/ beside cleetus.exe. No separate MXC installation is needed.",
          }
        : {}),
    });
    if (valid && pwsh && !/[\\/]WindowsApps[\\/]/i.test(pwsh)) {
      let failure: string | null;
      try {
        failure = await d.health(cwd, d.executor, pwsh);
      } catch {
        failure = "MXC or PowerShell could not start.";
      }
      checks.push({
        id: "mxc-runtime",
        label: "MXC capability and sandboxed PowerShell",
        requirement: "required",
        status: failure ? "fail" : "pass",
        detail: failure ?? "ProcessContainer, denied paths, and PowerShell 7.4+ are available.",
        ...(failure
          ? {
              remedy:
                "Install Windows updates and PowerShell 7.4+, or ask your administrator about application-control restrictions. Run cleetus doctor --windows after fixing the issue.",
            }
          : {}),
      });
    } else
      checks.push({
        id: "mxc-runtime",
        label: "MXC capability and sandboxed PowerShell",
        requirement: "required",
        status: "skip",
        detail: "Fix the missing package or shell prerequisite first.",
      });
  } else {
    checks.push({
      id: "mxc-runtime",
      label: "Native MXC",
      requirement: "recommended",
      status: "skip",
      detail: `sandbox.backend=${backend}; native MXC is not selected.`,
    });
    if (pwsh && needsShell) {
      let supported = false;
      try {
        supported = await d.shellVersion(pwsh);
      } catch {
        /* reported below */
      }
      checks.push({
        id: "shell-version",
        label: "PowerShell version",
        requirement: "required",
        status: supported ? "pass" : "fail",
        detail: supported
          ? "PowerShell 7.4+ starts successfully."
          : "PowerShell 7.4+ could not be verified.",
        ...(!supported
          ? { remedy: "Update PowerShell 7 and ensure pwsh.exe resolves to that installation." }
          : {}),
      });
    }
  }
  for (const [id, label, binary, remedy] of [
    [
      "git",
      "Git for Windows",
      "git.exe",
      "Install Git for Windows: https://git-scm.com/install/windows. Repository operations and checkpoints need native Git; Bash hooks may still fail inside MXC.",
    ],
    [
      "ripgrep",
      "ripgrep",
      "rg.exe",
      "Optional: install native ripgrep for faster searches; Cleetus has a built-in fallback.",
    ],
    [
      "terminal",
      "Windows Terminal",
      "wt.exe",
      "Optional: install Windows Terminal for the recommended TUI experience.",
    ],
    ["github", "GitHub CLI", "gh.exe", "Optional: install GitHub CLI only for GitHub operations."],
  ]) {
    const path = d.which(binary!);
    checks.push({
      id: id!,
      label: label!,
      requirement: "recommended",
      status: path ? "pass" : "warn",
      detail: path
        ? `${path}${d.architecture(path) ? ` (${d.architecture(path)})` : ""}`
        : "Not found on PATH.",
      ...(!path ? { remedy: remedy! } : {}),
    });
  }
  return report;
}

/** Read only inert root manifests/lockfiles; never run project scripts or install packages. */
export async function projectToolChecks(
  cwd: string,
  which: (name: string) => string | null = Bun.which,
): Promise<EnvironmentCheck[]> {
  const checks: EnvironmentCheck[] = [];
  const has = async (path: string) => Bun.file(join(cwd, path)).exists();
  const tools = new Map<string, [string, string]>();
  if (await has("package.json")) {
    let manager = "";
    try {
      manager = String(
        JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).packageManager ?? "",
      ).split("@")[0]!;
    } catch {
      /* other diagnostics handle malformed manifests */
    }
    const selected = ["bun", "npm", "pnpm", "yarn"].includes(manager)
      ? manager
      : (await has("bun.lock")) || (await has("bun.lockb"))
        ? "bun"
        : (await has("pnpm-lock.yaml"))
          ? "pnpm"
          : (await has("yarn.lock"))
            ? "yarn"
            : "npm";
    if (selected === "bun")
      tools.set("bun", [
        "Bun",
        "Install the project's Bun version; the runtime embedded in Cleetus is not a PATH-installed project tool.",
      ]);
    else {
      tools.set("node", ["Node.js", "Install the Node.js version required by this project."]);
      const pm = selected;
      tools.set(pm, [pm, `Install or enable this project's ${pm} package manager.`]);
    }
  }
  if ((await has("pyproject.toml")) || (await has("requirements.txt")))
    tools.set("python", [
      "Python",
      "Install the project's Python version and environment manager.",
    ]);
  if (await has("Cargo.toml"))
    tools.set("cargo", [
      "Rust/Cargo",
      "Install Rust using rustup; native dependencies may also require Visual Studio Build Tools.",
    ]);
  if (await has("go.mod")) tools.set("go", ["Go", "Install the project's Go toolchain."]);
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(cwd);
  if (files.some((f) => /\.(?:sln|slnx|csproj|fsproj|vbproj)$/i.test(f)))
    tools.set("dotnet", [
      ".NET SDK",
      "Install the .NET SDK required by global.json or this project.",
    ]);
  for (const [binary, [label, remedy]] of tools) {
    const path = which(binary);
    const alias = binary === "python" && /[\\/]WindowsApps[\\/]/i.test(path ?? "");
    checks.push({
      id: `project-${binary}`,
      label,
      requirement: "project",
      status: path && !alias ? "pass" : "warn",
      detail: alias
        ? `Python App Execution Alias found at ${path}; a working Python installation has not been verified.`
        : (path ?? "Project marker found, but the tool is missing on PATH."),
      ...(!path || alias ? { remedy } : {}),
    });
  }
  return checks;
}

/** Called only on first-run paths; output goes to stderr, including in ACP mode. */
export async function windowsFirstRunPrerequisites(
  cwd: string,
  backend: SandboxConfig["backend"],
  write: (text: string) => void,
  platform = process.platform,
  inspect = checkWindowsPrerequisites,
): Promise<boolean> {
  if (platform !== "win32") return true;
  const report = await inspect(cwd, backend);
  write(formatEnvironmentReport(report));
  return environmentExitCode(report) === 0;
}
