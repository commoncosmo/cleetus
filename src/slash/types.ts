export interface SlashPresentation {
  format?: "plain" | "markdown";
  kind?: "message" | "result";
  workflow?: string;
  status?: string;
  runId?: string;
}

export interface SlashContext {
  cwd: string;
  print: (text: string, presentation?: SlashPresentation) => void;
  /** Cancellation signal for long-running command work. */
  signal?: AbortSignal;
  /** Seed an agent turn with the given text. Provided by the interactive TUI; undefined
   *  in non-interactive contexts. Commands that need it (skills) must handle its absence. */
  runPrompt?: (text: string) => Promise<void>;
  /** Temporarily hand terminal control to the configured external editor. */
  openEditor?: (request: {
    args?: string;
    targets?: string[];
    /** Generic `/edit` only: request a one-time confirmation for targets outside cwd. */
    confirmOutsideProject?: boolean;
    /** Generic `/edit` only: exclusively create one empty project file before opening it. */
    create?: boolean;
  }) => Promise<void>;
  /** Edit a TUI-owned durable artifact and reconcile its live session state. */
  editArtifact?: (kind: "spec" | "plan", args: string) => Promise<string>;
}

export interface SlashCommand {
  name: string;
  description: string;
  aliases?: string[];
  /** True when the command accepts arguments (drives fill-vs-run on Enter). */
  takesArgs?: boolean;
  /** True when an argument-taking command can also run immediately without arguments. */
  argsOptional?: boolean;
  run: (args: string, ctx: SlashContext) => Promise<void> | void;
}
