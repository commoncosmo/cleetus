import { basename, isAbsolute, relative, resolve } from "node:path";

export interface DestructiveCommandDecision {
  blocked: boolean;
  reason?: string;
}

const SHELL_BOUNDARY = String.raw`(?:^|[;&|]\s*)`;
const CREATE_COMMAND =
  /(?:^|[;&|]\s*)(?:bunx\s+create-[\w@./-]+|bun\s+create\s+[\w@./-]+|(?:npm|pnpm|yarn)\s+(?:create|exec\s+create-)[\w@./-]*)\b/i;
const CURRENT_DIR_TARGET = /(?:^|\s)(?:--\s+)?(?:\.|\.\/)(?=\s|$)/;

function normalized(command: string): string {
  return command
    .replace(/\\\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasRmCommand(command: string): boolean {
  return new RegExp(`${SHELL_BOUNDARY}rm\\s+`, "i").test(command);
}

function targetsProtectedState(command: string, projectDir: string): boolean {
  const escapedProject = projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    String.raw`(?:^|\s|["'])${escapedProject}(?:\/\.(?:git|cleetus))(?:\/|\s|["']|$)|(?:^|[\s/"'])\.(?:git|cleetus)(?:\/|\s|["']|$)|\$\{?PWD\}?\/\.(?:git|cleetus)(?:\/|\s|["']|$)`,
    "i",
  ).test(command);
}

function targetsProjectRoot(command: string, projectDir: string): boolean {
  const resolvedProject = resolve(projectDir);
  const escapedProject = resolvedProject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedName = basename(resolvedProject).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(String.raw`(?:^|\s|["'])${escapedProject}\/?(?:\s|["']|$)`, "i").test(command) ||
    new RegExp(String.raw`(?:^|\s|["'])(?:\.\.\/)?${escapedName}\/?(?:\s|["']|$)`, "i").test(
      command,
    ) ||
    /(?:^|\s|["'])\$\{?PWD\}?\/?(?:\s|["']|$)/.test(command) ||
    /(?:^|\s)(?:--\s+)?(?:\.|\.\/|\*|\.\/\*)(?:\s|$)/.test(command)
  );
}

function targetsProjectSpine(command: string): boolean {
  return /(?:^|\s|["'])(?:src(?:\/(?:\*{1,2}|\{\*,\.\*\}))?\/?|package\.json|Cargo\.toml|go\.mod|pyproject\.toml|tsconfig(?:\.[\w.-]+)?\.json)(?:\s|["']|$)/i.test(
    command,
  );
}

/**
 * Non-overridable safety gate for shell operations whose normal meaning is to erase Cleetus's
 * control plane or replace an existing project wholesale. This runs inside BashTool after normal
 * permission resolution, so a persisted `bash: allow` rule cannot bypass it.
 *
 * This intentionally does not try to be a complete shell parser. OS sandbox protection covers
 * `.git`/`.cleetus` on supported host backends; this layer catches the common direct forms and
 * gives the model actionable steering before anything executes.
 */
export function destructiveCommandDecision(input: {
  command: string;
  projectDir: string;
  projectAlreadyExists: boolean;
}): DestructiveCommandDecision {
  const command = normalized(input.command);

  if (hasRmCommand(command) && targetsProtectedState(command, input.projectDir)) {
    return {
      blocked: true,
      reason: "refusing to delete Cleetus state or Git metadata from Bash",
    };
  }

  if (hasRmCommand(command) && targetsProjectRoot(command, input.projectDir)) {
    return {
      blocked: true,
      reason: "refusing a recursive/broad deletion targeting the project root",
    };
  }

  if (hasRmCommand(command) && targetsProjectSpine(command)) {
    return {
      blocked: true,
      reason: "refusing to delete a project-root manifest or the entire source tree from Bash",
    };
  }

  if (/\bgit\s+clean\b(?=[^\n]*-[a-z]*f)(?=[^\n]*-[a-z]*[dx])/i.test(command)) {
    return {
      blocked: true,
      reason: "refusing a forced Git clean that can erase untracked project or recovery files",
    };
  }

  if (/\bfind\s+(?:\.|\.\/)\s+[^\n;&|]*\s-delete\b/i.test(command)) {
    return {
      blocked: true,
      reason: "refusing a find -delete rooted at the whole project",
    };
  }

  if (
    input.projectAlreadyExists &&
    CREATE_COMMAND.test(command) &&
    CURRENT_DIR_TARGET.test(command)
  ) {
    return {
      blocked: true,
      reason:
        "refusing to run a project generator directly over a non-empty project; use the scaffold tool or edit the existing files",
    };
  }

  return { blocked: false };
}

export function destructiveCommandBlockMessage(reason: string): string {
  return `${reason}. This safety gate cannot be bypassed by a saved Bash permission. Use focused file tools, the dedicated scaffold tool for a genuinely fresh target, or ask the user to perform an explicitly destructive reset outside Cleetus.`;
}

/**
 * A `git init` that lands inside a strict subdirectory of the project orphans version control from
 * the files the user is actually working on — the recurring `project/project/.git` footgun where
 * the app files live at the root but the repository (and its `initial commit`) sits one level deep.
 * Detect the three forms the agent produces: an explicit `git init <subdir>` path argument, a bare
 * `git init` run from a subdirectory `cwd`, and a leading `cd <subdir> && git init`. Returns a
 * steering message, or null when the init targets the project root (or is unrelated to git init).
 */
export function nestedGitInitGrounding(input: {
  command: string;
  cwd?: string;
  projectDir: string;
}): string | null {
  const command = normalized(input.command);
  const init = command.match(/(?:^|[;&|]\s*)git\s+init\b([^;&|\n]*)/i);
  if (!init) return null;
  const root = resolve(input.projectDir);
  let base = input.cwd ? resolve(root, input.cwd) : root;
  // A leading `cd <dir> &&|;` changes where the init actually lands.
  const cd = command.match(/(?:^|[;&|]\s*)cd\s+(["']?)([^"'\s;&|]+)\1\s*(?:&&|;)/i);
  if (cd) base = resolve(base, cd[2]!);
  // An explicit path argument to `git init` wins over the cwd (flags like --bare/-q are ignored).
  const arg = (init[1] ?? "")
    .trim()
    .split(/\s+/)
    .find((token) => token.length > 0 && !token.startsWith("-"));
  const target = arg ? resolve(base, arg.replace(/^["']|["']$/g, "")) : base;
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const name = basename(root);
  return `\`git init\` targets \`${rel}\`, a subdirectory of the project. Initializing version control below the project root orphans the repository from your project files (the recurring \`${name}/${name}\` nesting bug). Run \`git init\` at the project root instead, or ask the user if a nested repository is genuinely intended.`;
}
