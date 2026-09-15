import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { resolveConfigRoot } from "../../config/config-root";
import {
  approveProjectConfiguration,
  projectConfigurationSnapshot,
} from "../../security/project-trust";

export async function runTrust(argv: string[], cwd: string): Promise<number> {
  const command = new Command("cleetus trust")
    .description(
      "Review and explicitly trust this project's configuration; grants may execute code and access credentials",
    )
    .option("--config-dir <path>", "global config directory outside the project")
    .option("--yes", "approve the current configuration after reviewing it");
  command.parse([...argv.slice(0, 2), ...argv.slice(3)]);
  const flags = command.opts<{ configDir?: string; yes?: boolean }>();
  const opts = {
    projectDir: cwd,
    globalPath: join(resolveConfigRoot(flags.configDir, homedir(), cwd), "config.yaml"),
  };
  const snapshot = await projectConfigurationSnapshot(opts);
  process.stdout.write(
    "Project config can run MCP servers/hooks, change permissions, and select providers. Trust only code you have reviewed.\n",
  );
  for (const [file, digest] of Object.entries(snapshot))
    process.stdout.write(`.cleetus/${file}: sha256 ${digest}\n`);
  if (flags.yes) {
    await approveProjectConfiguration(opts, snapshot);
    process.stdout.write(
      "Approved this configuration for this project location. Changed files require reapproval.\n",
    );
  } else
    process.stdout.write(
      "No trust granted. Review the files, then run cleetus trust --yes with the same --config-dir.\n",
    );
  return 0;
}
