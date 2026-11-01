import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { windowsQuote } from "../sandbox/windows";
import { terminalProjectTitle } from "../ui/windows-terminal";

export const CLEETUS_TERMINAL_GUID = "{a9900468-1bd8-4d8e-b0f1-fcfaa43fba8d}";
export interface CleetusLaunch {
  executable: string;
  args: string[];
}

/** Bun cannot resolve App Execution Aliases. Ask Windows for installed package locations
 * rather than running the alias through a shell or hardcoding a versioned WindowsApps path. */
export function installedTerminalPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = env.SystemRoot || env.WINDIR;
  if (!root) return [];
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $paths=@(foreach($name in @('Microsoft.WindowsTerminal','Microsoft.WindowsTerminalPreview')) { Get-AppxPackage -Name $name | Sort-Object Version -Descending | ForEach-Object { Join-Path $_.InstallLocation 'wt.exe' } }); ConvertTo-Json -Compress -InputObject $paths`;
  try {
    const result: unknown = JSON.parse(
      execFileSync(
        join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true, encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024 },
      ),
    );
    return Array.isArray(result)
      ? result.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}

export function findWindowsTerminal(
  which: (name: string) => string | null = Bun.which,
  packages: () => string[] = installedTerminalPaths,
): string | null {
  const onPath = which("wt.exe");
  if (onPath) return onPath;
  for (const candidate of packages()) {
    if (!isAbsolute(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

/** Source runs retain their Bun entry point; compiled distributions launch the executable. */
export function currentCleetusLaunch(
  executable = process.execPath,
  entry = process.argv[1],
): CleetusLaunch {
  return {
    executable,
    args: /^bun(?:\.exe)?$/i.test(basename(executable)) && entry ? [resolve(entry)] : [],
  };
}

export function terminalProfile(launch: CleetusLaunch) {
  return {
    cleetus: { schema: 1 },
    profiles: [
      {
        guid: CLEETUS_TERMINAL_GUID,
        name: "Cleetus",
        // Dropdown launches have no project argument and may inherit System32. Use the
        // managed global workspace; explicit terminal-open launches retain project scope.
        commandline: [launch.executable, ...launch.args, "--global"].map(windowsQuote).join(" "),
        startingDirectory: "%USERPROFILE%",
        suppressApplicationTitle: false,
        hidden: false,
      },
    ],
  };
}

export function terminalFragmentPath(localAppData: string): string {
  if (!isAbsolute(localAppData)) throw new Error("LOCALAPPDATA must be an absolute directory.");
  return join(
    localAppData,
    "Microsoft",
    "Windows Terminal",
    "Fragments",
    "Cleetus",
    "Cleetus.json",
  );
}

function inspectPath(path: string): void {
  let current = resolve(path);
  while (true) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1))
        throw new Error(`Refusing linked Terminal profile path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertOwned(path: string): void {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (
    raw?.cleetus?.schema !== 1 ||
    !Array.isArray(raw.profiles) ||
    raw.profiles.length !== 1 ||
    raw.profiles[0]?.guid !== CLEETUS_TERMINAL_GUID ||
    Object.keys(raw.profiles[0]).some(
      (key) =>
        ![
          "guid",
          "name",
          "commandline",
          "startingDirectory",
          "suppressApplicationTitle",
          "hidden",
        ].includes(key),
    ) ||
    Object.keys(raw).some((key) => key !== "cleetus" && key !== "profiles")
  )
    throw new Error(
      `Terminal profile is not owned exclusively by Cleetus; left unchanged: ${path}`,
    );
}

export function installTerminalProfile(launch: CleetusLaunch, localAppData: string): string {
  if (!statSync(launch.executable).isFile()) throw new Error("Cleetus executable must be a file.");
  const path = terminalFragmentPath(localAppData);
  inspectPath(path);
  if (existsSync(path)) assertOwned(path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.cleetus-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(terminalProfile(launch), null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return path;
}

export function uninstallTerminalProfile(localAppData: string): string | null {
  const path = terminalFragmentPath(localAppData);
  inspectPath(path);
  if (!existsSync(path)) return null;
  assertOwned(path);
  unlinkSync(path); // Only our fragment, never a recursive delete of Terminal/user settings.
  return path;
}

export interface TerminalPaneLayout {
  orientation?: "vertical" | "horizontal";
  size?: number;
}

export function validateTerminalPaneLayout(split: boolean, layout: TerminalPaneLayout): void {
  if (!split && (layout.orientation !== undefined || layout.size !== undefined))
    throw new Error("--vertical, --horizontal and --size require --split.");
  if (layout.orientation !== undefined && !["vertical", "horizontal"].includes(layout.orientation))
    throw new Error("Choose vertical or horizontal split orientation.");
  if (
    layout.size !== undefined &&
    (!Number.isFinite(layout.size) || layout.size < 0.01 || layout.size > 0.99)
  )
    throw new Error("--size must be a fraction from 0.01 to 0.99 (for example, 0.65).");
}

export function terminalOpenArgs(
  projectDir: string,
  launch: CleetusLaunch,
  split = false,
  layout: TerminalPaneLayout = {},
): string[] {
  validateTerminalPaneLayout(split, layout);
  const argv = [
    "-w",
    "0",
    split ? "split-pane" : "new-tab",
    ...(layout.orientation === "vertical"
      ? ["-V"]
      : layout.orientation === "horizontal"
        ? ["-H"]
        : []),
    ...(layout.size !== undefined ? ["--size", String(layout.size)] : []),
    "--useApplicationTitle",
    "--title",
    terminalProjectTitle(projectDir),
    "--startingDirectory",
    projectDir,
    "--",
    launch.executable,
    ...launch.args,
  ];
  // wt parses semicolons as additional actions even inside argv values. Refuse ambiguous
  // values rather than accidentally executing a second action; no shell is involved here.
  if (
    argv.some((arg) =>
      [...arg].some(
        (ch) =>
          ch === ";" ||
          ch.charCodeAt(0) < 32 ||
          (ch.charCodeAt(0) >= 127 && ch.charCodeAt(0) <= 159),
      ),
    )
  )
    throw new Error(
      "Windows Terminal launch paths must not contain semicolons or terminal control characters.",
    );
  return argv;
}
