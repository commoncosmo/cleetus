import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createConfinedEditorTarget } from "./create";
import { parseEditorWords } from "./words";

export interface EditorChild {
  exited: Promise<number>;
}

export interface EditorSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type SpawnEditor = (argv: string[], options: EditorSpawnOptions) => EditorChild;

export interface LaunchEditorOptions {
  cwd: string;
  /** Raw user-entered /edit arguments. Mutually exclusive with targets. */
  args?: string;
  /** Already-resolved feature-owned targets. Mutually exclusive with args. */
  targets?: string[];
  /** Generic `/edit` only: allow an interactive authorization callback for outside-cwd paths. */
  confirmOutsideProject?: boolean;
  /** Generic `/edit --create` only: exclusively create one project-confined empty file. */
  create?: boolean;
  authorizeOutsideProject?: (request: {
    editor: string;
    targets: string[];
  }) => Promise<boolean>;
  editor?: string | null;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  spawn?: SpawnEditor;
}

export interface EditorLaunchResult {
  argv: string[];
  targets: string[];
}

function defaultSpawn(argv: string[], options: EditorSpawnOptions): EditorChild {
  return Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

function resolveTarget(cwd: string, value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

const SECRET_ENV_NAME = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/iu;

/** Editors need normal terminal/process context, but not provider and workflow credentials. */
export function editorEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !SECRET_ENV_NAME.test(name)),
  ) as NodeJS.ProcessEnv;
}

function rejectUnsafeEditorCommand(argv: string[], source: "$EDITOR" | "$VISUAL"): void {
  const executable = argv[0]?.split(/[\\/]/u).at(-1)?.toLowerCase();
  const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
  if (
    executable &&
    shells.has(executable) &&
    argv.some((arg) => arg === "-c" || arg === "--command")
  ) {
    throw new Error(
      `${source} must name an editor, not a shell command interpreter ('${argv[0]} ${argv.find((arg) => arg === "-c" || arg === "--command")}'); use an editor executable or wrapper script`,
    );
  }
}

export async function launchEditor(options: LaunchEditorOptions): Promise<EditorLaunchResult> {
  const sourceEnv = options.env ?? process.env;
  const editor = options.editor === undefined ? sourceEnv.EDITOR : options.editor;
  const visual = options.editor === undefined ? sourceEnv.VISUAL : undefined;
  const configured = editor?.trim() ? editor : visual?.trim() ? visual : undefined;
  const configuredBy = editor?.trim() ? "$EDITOR" : "$VISUAL";
  if (!configured?.trim()) {
    throw new Error(
      "$EDITOR and $VISUAL are not set; configure one to a command such as 'vim' or 'code --wait'",
    );
  }

  const editorArgv = parseEditorWords(configured, configuredBy);
  if (!editorArgv[0]) throw new Error(`${configuredBy} does not contain an executable`);
  rejectUnsafeEditorCommand(editorArgv, configuredBy);

  if (options.args !== undefined && options.targets !== undefined) {
    throw new Error("editor launch cannot combine raw arguments with resolved targets");
  }
  if (options.create && options.targets !== undefined) {
    throw new Error("editor creation requires one raw /edit path");
  }
  if (options.create && options.confirmOutsideProject) {
    throw new Error("/edit --create cannot be combined with --outside-project");
  }
  const parsedTargets =
    options.targets !== undefined
      ? [...options.targets]
      : parseEditorWords(options.args ?? "", "/edit arguments");
  if (parsedTargets[0] === "--") parsedTargets.shift();
  const requestedTargets = parsedTargets.length > 0 ? parsedTargets : ["."];
  if (requestedTargets.some((target) => target.length === 0)) {
    throw new Error("/edit paths must not be empty");
  }

  let targets = requestedTargets.map((target) => resolveTarget(options.cwd, target));
  if (options.create) {
    if (requestedTargets.length !== 1) {
      throw new Error("/edit --create requires exactly one file path");
    }
    targets = [
      createConfinedEditorTarget({
        root: options.cwd,
        target: targets[0]!,
      }),
    ];
  }
  const pathExists = options.exists ?? existsSync;
  const missing = targets.find((target) => !pathExists(target));
  if (missing) throw new Error(`edit target does not exist: ${missing}`);

  // Raw args come only from generic `/edit`. Feature integrations pass host-resolved `targets`
  // and enforce their own, narrower roots before reaching the launcher.
  if (options.args !== undefined) {
    const resolveRealpath = options.realpath ?? realpathSync;
    const projectRoot = resolveRealpath(options.cwd);
    const outside = targets
      .map((target) => resolveRealpath(target))
      .filter((target) => !inside(projectRoot, target));
    if (outside.length > 0) {
      if (!options.confirmOutsideProject) {
        throw new Error(
          `edit target is outside the project: ${outside[0]}; use /edit --outside-project <path> to request one-time authorization`,
        );
      }
      if (!options.authorizeOutsideProject) {
        throw new Error("outside-project editor authorization is unavailable in this host");
      }
      const allowed = await options.authorizeOutsideProject({
        editor: editorArgv[0],
        targets: outside,
      });
      if (!allowed) throw new Error("outside-project edit cancelled");
    }
  }

  const argv = [...editorArgv, ...targets];
  const spawn = options.spawn ?? defaultSpawn;
  const env = editorEnvironment(sourceEnv);
  const ignoreSigint = () => {};
  process.on("SIGINT", ignoreSigint);
  try {
    let child: EditorChild;
    try {
      child = spawn(argv, { cwd: options.cwd, env });
    } catch (error) {
      throw new Error(`could not launch editor '${editorArgv[0]}': ${(error as Error).message}`);
    }
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`editor '${editorArgv[0]}' exited with status ${exitCode}`);
    }
  } finally {
    process.off("SIGINT", ignoreSigint);
  }
  return { argv, targets };
}
