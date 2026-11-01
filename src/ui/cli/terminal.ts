import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  type CleetusLaunch,
  type TerminalPaneLayout,
  currentCleetusLaunch,
  findWindowsTerminal,
  installTerminalProfile,
  installedTerminalPaths,
  terminalOpenArgs,
  uninstallTerminalProfile,
  validateTerminalPaneLayout,
} from "../../windows/terminal";

export interface TerminalCliIO {
  write: (text: string) => void;
  writeErr: (text: string) => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  launch?: CleetusLaunch;
  which?: (name: string) => string | null;
  packages?: () => string[];
  run?: (executable: string, argv: string[]) => void;
}

export function runTerminal(argv: string[], cwd: string, io: TerminalCliIO): number {
  const command = new Command()
    .name("cleetus terminal")
    .description("Manage the Windows Terminal profile or open a project tab/pane")
    .argument("<action>", "install | uninstall | open")
    .argument("[directory]", "project directory for open (defaults to the current directory)")
    .option("--split", "open in a split pane instead of a new tab")
    .option("--vertical", "split side-by-side (requires --split)")
    .option("--horizontal", "split above/below (requires --split)")
    .option("--size <fraction>", "new pane's initial share, 0.01–0.99 (requires --split)")
    .option("--executable <path>", "explicit Cleetus executable for this profile or launch")
    .exitOverride()
    .configureOutput({ writeOut: io.write, writeErr: io.writeErr });
  try {
    command.parse(argv.slice(3), { from: "user" });
    const [action, directory] = command.args;
    const options = command.opts<{
      split?: boolean;
      vertical?: boolean;
      horizontal?: boolean;
      size?: string;
      executable?: string;
    }>();
    if (!["install", "uninstall", "open"].includes(action!))
      throw new Error("Use terminal install, uninstall, or open [directory].");
    if (
      action !== "open" &&
      (directory ||
        options.split ||
        options.vertical ||
        options.horizontal ||
        options.size !== undefined)
    )
      throw new Error("A directory and pane layout options apply only to terminal open.");
    if (options.vertical && options.horizontal)
      throw new Error("Choose either --vertical or --horizontal, not both.");
    const layout: TerminalPaneLayout = {
      orientation: options.vertical ? "vertical" : options.horizontal ? "horizontal" : undefined,
      size: options.size !== undefined ? Number(options.size) : undefined,
    };
    validateTerminalPaneLayout(Boolean(options.split), layout);
    if (action === "uninstall" && options.executable)
      throw new Error("--executable does not apply to terminal uninstall.");
    if ((io.platform ?? process.platform) !== "win32")
      throw new Error("Windows Terminal commands require native Windows.");
    const env = io.env ?? process.env;
    const launch = options.executable
      ? { executable: realpathSync(resolve(cwd, options.executable)), args: [] }
      : (io.launch ?? currentCleetusLaunch());
    if (action === "open") {
      const projectDir = realpathSync(resolve(cwd, directory ?? "."));
      if (!statSync(projectDir).isDirectory()) throw new Error("Project path must be a directory.");
      if (!statSync(launch.executable).isFile())
        throw new Error("Cleetus executable must be a file.");
      const executable = findWindowsTerminal(
        io.which,
        io.packages ?? (() => installedTerminalPaths(env)),
      );
      if (!executable)
        throw new Error(
          "Windows Terminal was not found. Install Windows Terminal or make an unpackaged wt.exe available on PATH, then retry.",
        );
      const args = terminalOpenArgs(projectDir, launch, options.split, layout);
      (
        io.run ??
        ((exe, args) => {
          const result = spawnSync(exe, args, {
            windowsHide: false,
            encoding: "utf8",
            timeout: 15000,
          });
          if (result.error) throw result.error;
          if (result.status !== 0)
            throw new Error(
              `Windows Terminal could not launch the project (exit ${result.status}): ${result.stderr.trim()}`,
            );
        })
      )(executable, args);
      io.write(`Opened Cleetus ${options.split ? "pane" : "tab"} in ${projectDir}.\n`);
    } else {
      if (!env.LOCALAPPDATA)
        throw new Error("LOCALAPPDATA is required for the per-user Terminal profile.");
      const path =
        action === "install"
          ? installTerminalProfile(launch, env.LOCALAPPDATA)
          : uninstallTerminalProfile(env.LOCALAPPDATA);
      io.write(
        path
          ? `${action === "install" ? "Installed" : "Removed"} Cleetus Terminal profile: ${path}\n${action === "install" ? "Restart Windows Terminal to load the profile.\n" : ""}`
          : "Cleetus Terminal profile is not installed.\n",
      );
    }
    return 0;
  } catch (error) {
    if ((error as { code?: string }).code === "commander.helpDisplayed") return 0;
    io.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
