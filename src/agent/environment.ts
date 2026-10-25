import { join } from "node:path";

/** A system-prompt fragment grounding the model in its working directory. Prevents the
 *  failure mode where a model invents an absolute path for a file tool — including reads,
 *  where a weak orchestration worker would otherwise retype and mangle the project root
 *  (#114). Also names the host OS so the model does not reach for GNU-only shell flags
 *  (e.g. `cat -A`) on a BSD/macOS host, which fail outright and waste a round-trip (#157).
 *  Finally, pins today's date: a model otherwise assumes the current year is its training
 *  cutoff and forms stale web searches ("install xyz 2024") instead of using the live year.
 *  `now` is injected (default live clock) so the date is testable; real callers pin it once
 *  per session for prompt byte-stability. */
export function renderEnvironment(
  projectDir: string,
  platform: NodeJS.Platform = process.platform,
  now: Date = new Date(),
): string {
  // biome wants this as one template literal (interpolation forbids splitting it across a `+`
  // chain), so it lives on a single line.
  const searchGuidance = `Your training data has an earlier cutoff, so when you search the web for current, latest, or recent information, build the query around today's date — do not default to your training-cutoff year (for example, search "<topic> ${now.getFullYear()}", not "<topic> 2024").`;
  return [
    `Working directory: ${projectDir}`,
    `Host OS: ${describePlatform(platform)}`,
    ...(platform === "win32"
      ? [
          "For native Windows execution, the shell tool retains the name bash but advertises PowerShell 7 syntax. Follow the tool's advertised shell: Docker/WSL keep Bash. MSYS/Git Bash cannot initialize inside native MXC.",
          "PowerShell examples: list files with Get-ChildItem -Force (not ls -la); discover executables with Get-Command (not which); set variables with $env:NAME='value' (not NAME=value command); invoke an executable variable with & $exe --version. Environment changes last only for that tool call. Use the provided writable temp/cache locations, never .cleetus for scratch files. Prefer file tools over verbose formatted shell listings.",
          "PowerShell path arguments are arrays: Get-ChildItem -LiteralPath 'src','public' and Remove-Item -LiteralPath 'one.log','two.log' -Force. Parameters use one dash (-Include). Use Invoke-WebRequest for HTTP; Get-Content reads files. /tmp and $! are Bash conventions. For a web server use render_check with launchCommand and url in one call; smoke_run stops the server afterward. Do not launch npm/npx shims with Start-Process or chase jobs across calls. Stop automatic browser/server workarounds when verification reports a fixed prerequisite failure.",
        ]
      : []),
    `Today's date is ${describeDate(now)}.`,
    searchGuidance,
    "Use paths relative to this working directory for every file tool — reading, writing, " +
      "and editing. You never need to retype the project root. Do not use absolute paths or " +
      "write outside this directory unless the user explicitly asks.",
  ].join("\n");
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Render a date as `Weekday, Month D, YYYY (YYYY-MM-DD)` using LOCAL calendar fields, so
 *  "today" tracks the user's wall clock (a UTC `toISOString()` would be off by a day near
 *  midnight). Pure; the clock is passed in for testability. */
function describeDate(now: Date): string {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return `${WEEKDAYS[now.getDay()]}, ${MONTHS[month]} ${day}, ${year} (${iso})`;
}

/** Render a `process.platform` value as a human sentence, naming coreutils flavor so the model
 *  avoids platform-incompatible shell idioms. Pure; the platform is passed in for testability. */
function describePlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return (
        "macOS (BSD coreutils — GNU-only flags such as `cat -A` or `ls --color` are " +
        "unavailable; prefer portable POSIX options)."
      );
    case "linux":
      return "Linux (GNU coreutils).";
    case "win32":
      return "Windows.";
    default:
      return `${platform}.`;
  }
}

/** One-line grounding for a project's passive shared artifact folder, or "" when there is no
 *  project-home anchor. Appended AFTER renderEnvironment in the ACP system-prompt closures so
 *  the model can read/write shared artifacts with ordinary file tools. Pure. */
export function renderArtifactGrounding(projectHome?: string): string {
  if (!projectHome) return "";
  return `Project shared artifact space: ${join(projectHome, "artifacts")} — files here are shared across all chats and terminals in this project.`;
}
