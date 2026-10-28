import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { resolveConfigRoot } from "../../config/config-root";
import { loadConfig } from "../../config/loader";
import { userPaths } from "../../config/user-paths";
import { WindowsSandbox, windowsExecutorPath } from "../../sandbox/windows";
import { providerEnvironmentChecks } from "../../setup/provider-environment";
import { checkWindowsEnforcement } from "../../setup/windows-enforcement";
import {
  checkWindowsPrerequisites,
  environmentExitCode,
  formatEnvironmentReport,
  projectToolChecks,
} from "../../setup/windows-environment";

export async function runDoctor(
  argv: string[],
  cwd: string,
  io: { write: (s: string) => void; writeErr: (s: string) => void },
): Promise<number> {
  const program = new Command()
    .name("cleetus doctor")
    .description(
      "Check native Windows prerequisites and sandbox enforcement; never install tools or run project scripts.",
    )
    .option("--windows", "check the native Windows environment")
    .option("--quick", "skip synthetic filesystem and process-cleanup tests")
    .option("--json", "output a structured report")
    .option("--config-dir <path>", "read configuration from this directory")
    .option("--executor <path>", "explicit MXC executor path for source/development builds")
    .exitOverride()
    .configureOutput({ writeOut: io.write, writeErr: io.writeErr });
  try {
    program.parse(argv.slice(3), { from: "user" });
  } catch (e) {
    return (e as { code?: string }).code === "commander.helpDisplayed" ? 0 : 2;
  }
  const opts = program.opts<{
    quick?: boolean;
    json?: boolean;
    configDir?: string;
    executor?: string;
  }>();
  const executor = opts.executor ? resolve(cwd, opts.executor) : windowsExecutorPath();
  const report = await checkWindowsPrerequisites(cwd, "host", { executor });
  const paths = userPaths();
  report.checks.push({
    id: "user-paths",
    label: "User data paths",
    requirement: "recommended",
    status: paths.mode === "legacy" || paths.conflict ? "warn" : "pass",
    detail: `Mode: ${paths.conflict && !opts.configDir ? "conflict" : paths.mode}; installation: ${paths.installRoot}; config/state: ${opts.configDir ? resolveConfigRoot(opts.configDir, homedir(), cwd) : paths.configRoot}; default workspace: ${paths.workspaceRoot}; legacy config: ${paths.legacyConfig}; native data: ${paths.nativeRoot}`,
    ...(paths.mode === "legacy"
      ? {
          remedy:
            "Run cleetus migrate-data to preview migration; close other instances before applying with --yes.",
        }
      : {}),
  });
  if (report.platform === "win32") {
    try {
      report.checks.push(...(await projectToolChecks(cwd)));
    } catch {
      report.checks.push({
        id: "project-tools",
        label: "Project tool discovery",
        requirement: "project",
        status: "warn",
        detail: "Project markers could not be read; tool recommendations were skipped.",
      });
    }
    if (!opts.quick && environmentExitCode(report) === 0) {
      try {
        report.checks.push(...(await checkWindowsEnforcement(executor, Bun.which("pwsh.exe")!)));
      } catch {
        report.checks.push({
          id: "enforcement",
          label: "Synthetic enforcement tests",
          requirement: "required",
          status: "fail",
          detail: "The disposable diagnostic workspace could not be created or completed.",
          remedy:
            "Check home-directory permissions and application-control restrictions, then retry the doctor.",
        });
      }
      const git = Bun.which("git.exe");
      if (git) {
        const sandbox = new WindowsSandbox(cwd, false, executor);
        let works = false;
        try {
          const result = await sandbox.execArgv([git, "--version"], {
            signal: new AbortController().signal,
            timeoutMs: 5000,
          });
          works = result.exitCode === 0 && !result.timedOut;
        } catch {
          /* diagnostic below */
        } finally {
          await sandbox.dispose();
        }
        report.checks.push({
          id: "git-sandbox",
          label: "Sandboxed Git",
          requirement: "recommended",
          status: works ? "pass" : "warn",
          detail: works
            ? "Native Git starts inside MXC."
            : "Git was found but could not start inside MXC; repository features may be unavailable.",
        });
      }
    } else {
      report.checks.push({
        id: "enforcement",
        label: "Synthetic enforcement tests",
        requirement: "required",
        status: "skip",
        detail: opts.quick
          ? "Skipped by --quick; prerequisite checks do not certify enforcement."
          : "Fix required prerequisites before running enforcement tests.",
      });
    }
    try {
      const globalDir = resolveConfigRoot(opts.configDir, homedir(), cwd);
      const config = await loadConfig({
        globalPath: join(globalDir, "config.yaml"),
        projectDir: cwd,
      });
      const providers = Object.entries(config.providers);
      if (
        config.hooks.some((h) =>
          /(?:\b(?:bash|sh|wsl)(?:\.exe)?\b|\/bin\/|\.sh\b)/i.test(h.command),
        )
      ) {
        report.checks.push({
          id: "shell-compatibility",
          label: "Configured hooks",
          requirement: "recommended",
          status: "warn",
          detail: "A configured hook appears to require Bash/WSL or a .sh script.",
          remedy:
            "Review it for a PowerShell/native equivalent. MSYS/Git Bash cannot initialize inside MXC; no hook was executed by the doctor.",
        });
      }
      if (!providers.length)
        report.checks.push({
          id: "provider",
          label: "Inference provider",
          requirement: "recommended",
          status: "warn",
          detail: "No provider configured.",
          remedy:
            "Start Cleetus to detect a local provider, or configure a local/remote endpoint; see docs/providers.md.",
        });
      const results = await providerEnvironmentChecks(providers);
      report.checks.push(...results);
    } catch {
      report.checks.push({
        id: "config",
        label: "Provider configuration",
        requirement: "recommended",
        status: "warn",
        detail:
          "Could not load configuration; provider checks were skipped. Configuration values are omitted.",
      });
    }
  }
  io.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatEnvironmentReport(report));
  return environmentExitCode(report);
}
