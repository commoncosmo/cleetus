import { homedir } from "node:os";
import { Command } from "commander";
import { migrateWindowsData } from "../../config/migrate-data";
import { userPaths } from "../../config/user-paths";

export function runMigrateData(argv: string[]): number {
  const command = new Command()
    .name("cleetus migrate-data")
    .description(
      "Preview migration from legacy Windows data; close all Cleetus instances before applying",
    )
    .option("--yes", "move legacy configuration and the default global workspace without merging")
    .option("--json", "output paths and migration results as JSON")
    .exitOverride();
  try {
    command.parse(argv.slice(3), { from: "user" });
    const result = migrateWindowsData(homedir(), {}, Boolean(command.opts().yes));
    const output = { ...result, paths: userPaths() };
    console.log(
      command.opts().json
        ? JSON.stringify(output)
        : [...result.moves.map((m) => `${m.from} -> ${m.to}`), result.message].join("\n"),
    );
    return 0;
  } catch (error) {
    if ((error as { code?: string }).code === "commander.helpDisplayed") return 0;
    const message = (error as Error).message;
    if (command.opts().json)
      console.log(JSON.stringify({ applied: false, error: message, paths: userPaths() }));
    else
      console.error(
        `${message}\nLegacy config: ${userPaths().legacyConfig}\nNative data: ${userPaths().nativeRoot}`,
      );
    return 1;
  }
}
