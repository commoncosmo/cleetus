import { isAbsolute, resolve } from "node:path";
import { comparablePath } from "../lib/paths";
import type { Sandbox } from "../sandbox/types";
import { realpathWithMissingParents } from "./path-guard";
import type { PermissionRule } from "./types";

export interface CommandContext {
  command: string;
  cwd: string;
  shell: string;
}

export async function commandShellIdentity(sandbox: Sandbox): Promise<string> {
  const kind = sandbox.shell ?? "bash";
  const executable =
    (await sandbox.shellExecutable?.()) ?? Bun.which(kind === "powershell" ? "pwsh.exe" : "bash");
  if (!executable) return "";
  const selected = Bun.which(executable) ?? executable;
  const canonical = isAbsolute(selected) ? await realpathWithMissingParents(selected) : selected;
  return `${kind}:${canonical}`;
}

/** Deliberately a small language, not a shell parser. Unrecognized shell syntax asks again. */
export function commandWords(text: string): string[] | null {
  if (
    !text.trim() ||
    text.length > 4096 ||
    [...text].some(
      (ch) =>
        ch.charCodeAt(0) < 32 ||
        (ch.charCodeAt(0) >= 127 && ch.charCodeAt(0) <= 159) ||
        ch === "\u2028" ||
        ch === "\u2029",
    ) ||
    /[;&|<>$`%!^(){}#]/.test(text)
  )
    return null;
  const words: string[] = [];
  let word = "";
  let quote = "";
  let active = false;
  for (const ch of text) {
    if (ch === "'" || ch === '"') {
      if (quote === ch) quote = "";
      else if (!quote) quote = ch;
      else word += ch;
      active = true;
    } else if (/\s/.test(ch) && !quote) {
      if (active) words.push(word);
      word = "";
      active = false;
    } else {
      word += ch;
      active = true;
    }
  }
  if (quote) return null;
  if (active) words.push(word);
  // A shell may interpret a backslash before whitespace/quotes differently. Decline ambiguous
  // escaped input on every platform; ordinary quoted Windows paths remain supported.
  if (words.length > 128 || /\\[\s'"]/.test(text)) return null;
  return words;
}

export function validCommandPattern(pattern: string): boolean {
  const words = commandWords(pattern);
  if (!words || !words.length || !words[0] || /[*?\[\]=]/.test(words[0])) return false;
  // Interpreter payloads must never become reusable wildcard approvals.
  const program = words[0]!
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)!
    .replace(/[ .]+$/, "")
    .replace(/\.exe$/i, "");
  if (
    /^(?:bash|sh|zsh|fish|dash|cmd|powershell|pwsh|python\d*(?:\.\d+)?|node|deno|perl|ruby|php|lua|wscript|cscript|mshta|osascript|eval|exec|env|sudo|xargs|iex|invoke-expression|invoke-command)$/i.test(
      program,
    )
  )
    return false;
  // Keep dispatchers' subcommand fixed, so approval of tests cannot become a new action.
  if (/^(?:bun|npm|npx|pnpm|yarn|git|cargo|dotnet|go|uv|pip\d*)$/i.test(program)) {
    return (
      words.length >= 2 && !!words[1] && !/[*?\[\]=]/.test(words[1]!) && !words[1]!.startsWith("-")
    );
  }
  return true;
}

function wordMatches(pattern: string, value: string): boolean {
  // Greedy wildcard matching with a bounded input, avoiding backtracking regexes.
  let p = 0;
  let v = 0;
  let star = -1;
  let retry = 0;
  while (v < value.length) {
    if (pattern[p] === value[v]) {
      p++;
      v++;
    } else if (pattern[p] === "*") {
      star = p++;
      retry = v;
    } else if (star !== -1) {
      p = star + 1;
      v = ++retry;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

export function commandPatternMatches(pattern: string, command: string): boolean {
  if (!validCommandPattern(pattern)) return false;
  const expected = commandWords(pattern)!;
  const actual = commandWords(command);
  if (!actual) return false;
  let reachable = new Set([0]);
  for (const word of expected) {
    const next = new Set<number>();
    for (const start of reachable) {
      if (word === "*") {
        for (let end = start; end <= actual.length; end++) next.add(end);
      } else if (start < actual.length && wordMatches(word, actual[start]!)) next.add(start + 1);
    }
    reachable = next;
  }
  return reachable.has(actual.length);
}

export function commandRuleMatches(rule: PermissionRule, context?: CommandContext): boolean {
  return (
    !!context &&
    !!rule.commandPattern &&
    !!rule.commandCwd &&
    !!rule.commandShell &&
    comparablePath(context.cwd) === comparablePath(rule.commandCwd) &&
    comparablePath(context.shell) === comparablePath(rule.commandShell) &&
    commandPatternMatches(rule.commandPattern, context.command)
  );
}

export function buildCommandRule(
  pattern: string,
  context: CommandContext,
): Omit<PermissionRule, "decision"> | null {
  if (!context.shell || !context.cwd || !validCommandPattern(pattern)) return null;
  return {
    tool: "bash",
    commandPattern: pattern.trim(),
    commandCwd: context.cwd,
    commandShell: context.shell,
  };
}

export async function resolveCommandContext(
  args: unknown,
  projectDir: string,
  shell: string,
): Promise<CommandContext | undefined> {
  const input = args as { command?: unknown; cwd?: unknown } | null;
  if (typeof input?.command !== "string" || !shell) return undefined;
  return {
    command: input.command,
    cwd: await realpathWithMissingParents(
      resolve(projectDir, typeof input.cwd === "string" ? input.cwd : "."),
    ),
    shell,
  };
}

export function suggestedCommandPattern(command: string): string | null {
  const words = commandWords(command);
  if (!words || words.length < 2) return null;
  const pattern = `${words
    .slice(0, 2)
    .map((w) => (/\s/.test(w) ? JSON.stringify(w) : w))
    .join(" ")} *`;
  return commandPatternMatches(pattern, command) ? pattern : null;
}
