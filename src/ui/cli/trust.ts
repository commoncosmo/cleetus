import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { resolveConfigRoot } from "../../config/config-root";
import { resolveLaunchScope } from "../../config/launch-scope";
import { loadConfig } from "../../config/loader";
import {
  approveProjectConfiguration,
  projectConfigurationSnapshot,
  projectTrustCommand,
} from "../../security/project-trust";

export async function runTrust(argv: string[], cwd: string): Promise<number> {
  const command = new Command("cleetus trust")
    .description(
      "Review and explicitly trust this project's configuration; grants may execute code and access credentials",
    )
    .option("--config-dir <path>", "global config directory outside the project")
    .option("--global", "trust the configured global workspace from any directory")
    .option("--directory <path>", "trust a project directory without changing cwd")
    .option("--yes", "approve the current configuration after reviewing it");
  command.parse([...argv.slice(0, 2), ...argv.slice(3)]);
  const flags = command.opts<{
    configDir?: string;
    yes?: boolean;
    global?: boolean;
    directory?: string;
  }>();
  if (flags.global && flags.directory) throw new Error("choose either --global or --directory");
  const globalPath = join(resolveConfigRoot(flags.configDir, homedir(), cwd), "config.yaml");
  const globalConfig = flags.global
    ? await loadConfig({ globalPath, projectDir: cwd, globalOnly: true })
    : undefined;
  const opts = {
    projectDir: flags.global
      ? resolveLaunchScope({
          global: true,
          scratch: false,
          cwd,
          home: homedir(),
          globalWorkspaceDir: globalConfig?.globalWorkspaceDir,
        }).dir
      : resolve(cwd, flags.directory ?? "."),
    globalPath,
    trustGlobalWorkspace: flags.global,
  };
  const snapshot = await projectConfigurationSnapshot(opts);
  process.stdout.write(
    `Workspace: ${opts.projectDir}\nProject config can run MCP servers/hooks, change permissions, and select providers. Trust only code you have reviewed.\n`,
  );
  for (const [file, digest] of Object.entries(snapshot))
    process.stdout.write(`.cleetus/${file}: sha256 ${digest}\n`);
  if (flags.yes) {
    await approveProjectConfiguration(opts, snapshot);
    process.stdout.write(
      "Approved this configuration for this project location. Changes to configuration authority require reapproval.\n",
    );
  } else
    process.stdout.write(
      `No trust granted. Review the files, then run: ${projectTrustCommand(opts)}\n`,
    );
  return 0;
}
