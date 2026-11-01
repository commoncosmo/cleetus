import { basename, win32 } from "node:path";
import { sanitizeTerminalText } from "./terminal-text";

export type TerminalActivity = "running" | "waiting" | "clear";
type Output = Pick<NodeJS.WriteStream, "isTTY" | "write">;

function enabled(output: Output, env: NodeJS.ProcessEnv): boolean {
  return !!output.isTTY && !!env.WT_SESSION && env.CLEETUS_TERMINAL_INTEGRATION !== "0";
}

/** Titles contain a short project label, never commands, prompts, or model output. */
export function terminalProjectTitle(projectDir: string): string {
  const leaf = projectDir.includes("\\") ? win32.basename(projectDir) : basename(projectDir);
  const label = sanitizeTerminalText(leaf || projectDir)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return label ? `Cleetus · ${label}` : "Cleetus";
}

/** Only emit trusted application state, and only to an interactive Windows Terminal. */
export function terminalProgress(
  state: TerminalActivity,
  output: Output = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!enabled(output, env) || env.CLEETUS_TERMINAL_PROGRESS === "0") return;
  const code = state === "running" ? 3 : state === "waiting" ? 4 : 0;
  output.write(`\x1b]9;4;${code};0\x07`);
}

export function terminalActivity(
  state: TerminalActivity,
  projectDir: string,
  output: Output = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!enabled(output, env)) return;
  terminalProgress(state, output, env);
  const suffix = state === "running" ? " · Working" : state === "waiting" ? " · Needs input" : "";
  output.write(`\x1b]0;${terminalProjectTitle(projectDir)}${suffix}\x07`);
}

/** Report the session root once; transient tool cwd changes must not affect tab inheritance. */
export function terminalDirectory(
  projectDir: string,
  output: Output = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    !enabled(output, env) ||
    !win32.isAbsolute(projectDir) ||
    !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(projectDir)
  )
    return;
  if (
    [...projectDir].some(
      (ch) =>
        ch.charCodeAt(0) < 32 || (ch.charCodeAt(0) >= 127 && ch.charCodeAt(0) <= 159) || ch === '"',
    )
  )
    return;
  output.write(`\x1b]9;9;"${projectDir}"\x07`);
}
