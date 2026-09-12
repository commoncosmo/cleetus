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
