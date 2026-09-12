# Editing files from Cleetus

The interactive Cleetus TUI can temporarily hand its terminal to the editor configured in
`$EDITOR`, or `$VISUAL` when `$EDITOR` is unset. Use `/edit` with no arguments to open the current
project directory:

```text
cleetus> /edit
```

Pass one or more existing files or directories to open specific targets:

```text
cleetus> /edit README.md
cleetus> /edit docs/workflows "notes with spaces.md"
cleetus> /edit -- -filename
```

Relative paths are resolved from Cleetus's project directory. Each target must already exist;
ordinary `/edit` does not create a missing file. To create one new project file and open it, use:

```text
cleetus> /edit --create notes/decisions/editor.md
cleetus> /edit --create "notes with spaces.md"
```

Creation accepts exactly one file path. Cleetus creates missing parent directories, then creates a
zero-byte file exclusively: an existing file or directory is never opened, truncated, or replaced
by `--create`. If the editor saves no content, the empty file remains. The created file and any
new parents also remain if the editor fails to launch or exits unsuccessfully.

`--create` is confined to the project and cannot be combined with `--outside-project`. Lexical
escapes such as `../outside.md` and symlinked parent directories are rejected. Use ordinary
`/edit` for existing files, including an existing project file that you initially created with
this command.

Targets inside the project open immediately. Absolute paths, `~/...` paths, and project paths whose
real target escapes through a symlink require the explicit outside-project form:

```text
cleetus> /edit --outside-project ~/.ssh/config
```

Cleetus displays the resolved external targets and editor executable and asks for one-time
confirmation. This authorization is never persisted. Feature-aware editor commands do not inherit
this override.

## Configure the editor

Set `EDITOR` before starting Cleetus. If `EDITOR` is unset or blank, Cleetus falls back to
`VISUAL`. When both are set, `EDITOR` takes precedence. Either value may include editor arguments:

```bash
export EDITOR=vim
export EDITOR="nvim"
export EDITOR="code --wait"
export VISUAL="code --wait"
```

Cleetus parses the command and path arguments directly and starts the editor without a shell.
Single quotes, double quotes, and backslash escapes are supported for grouping. Shell expansion is
intentionally not performed, so glob patterns, pipes, command substitution, and environment
variable references remain literal arguments. `$EDITOR` and `$VISUAL` configurations that invoke a
shell command interpreter, such as `sh -c`, are rejected; use an editor executable or a trusted
wrapper script.

The child receives normal terminal and process context, but Cleetus removes environment variables
whose names identify API keys, tokens, secrets, passwords, or credentials.

## Compatibility matrix

Terminal editors naturally keep the Cleetus handoff open until they exit. Graphical editors must
use a foreground or wait option; without one, the launcher may return immediately and Cleetus will
resume before editing is finished.

| Editor | Recommended configuration | Surface | Handoff completion | Smoke profile |
|---|---|---|---|---|
| Vi / system Vim | `EDITOR=vi` | Terminal | Editor process exits | `vi` |
| Vim | `EDITOR=vim` | Terminal | Editor process exits | `vim` |
| Neovim | `EDITOR=nvim` | Terminal | Editor process exits | `nvim` |
| Helix | `EDITOR=hx` | Terminal | Editor process exits | `helix` |
| Visual Studio Code | `EDITOR="code --wait"` | Graphical | Opened files close | `code-wait` |
| BBEdit | `EDITOR="bbedit --wait"` | Graphical, macOS | Opened document closes | `bbedit` |
| gVim | `EDITOR="gvim -f"` | Graphical | Editor window closes | `gvim` |
| MacVim | `EDITOR="mvim -f"` | Graphical, macOS | Editor window closes | `macvim` |
| TextEdit through `open` | `EDITOR="open -W -a TextEdit"` | Graphical, macOS | TextEdit terminates | `textedit` |

The argument construction, foreground flags, platform gates, paths containing spaces, and saved
marker check are covered by automated tests. Vi/system Vim has completed a live Cleetus TUI
handoff on macOS, and the `vim` profile has completed the production-launcher smoke harness. Other
live results should be recorded only after running the smoke harness on a machine where that editor
is installed.

### Compatibility smoke harness

The contributor smoke harness uses the production editor launcher and a temporary Markdown file.
Listing profiles and checking executable availability are non-interactive and never launch an
editor:

```bash
bun run smoke:editor
bun run smoke:editor -- --check
```

Choose a profile explicitly to perform a real modal handoff:

```bash
bun run smoke:editor -- --profile vim
bun run smoke:editor -- --profile code-wait
```

The opened file asks you to replace one marker, save it, and close the editor. The harness passes
only when the launcher waits and the exact saved marker is present after return. It always removes
its temporary directory. GUI profiles can open applications and therefore are never run by
`--list`, `--check`, the unit suite, or CI.

## Terminal handoff

`/edit` is modal in v1:

1. Cleetus removes its interactive input and releases raw terminal input.
2. The configured editor inherits stdin, stdout, and stderr.
3. Cleetus waits for that editor process to exit.
4. The Cleetus prompt and status display return in the same session.

Terminal editors such as Vim and Neovim normally use the terminal's alternate screen, which makes
the transition feel like switching between two terminal views. Graphical editors decide their own
waiting behavior. For example, `code --wait` keeps Cleetus suspended until the opened files close,
while an editor command that immediately returns also returns control to Cleetus immediately.

The submitted `/edit` command remains in prompt history. Opening an editor does not invoke a model,
start a Cleetus busy indicator, or grant the editor any Cleetus tool permissions; the editor is a
normal child process with the user's existing operating-system authority.

### Audit trail

Each editor handoff records durable, verbose-only `editor_audit` lifecycle events in the Cleetus
session log. These events identify the editor integration, lifecycle phase, success or normalized
failure category, elapsed time, target count, project/outside/mixed scope, and one-time external
authorization decision. The executable is reduced to its basename.

The audit payload never contains target paths, workflow or skill names, raw `/edit` arguments,
editor arguments, or raw error messages. It may record that project-file creation was requested.
External authorization prompts still show the full paths ephemerally so the user can make an
informed decision; those paths are not copied into the audit events.

## Feature-aware editing

Use the owning command when an artifact has a lifecycle beyond its filesystem path:

```text
/workflow edit weather-fetch
/skill edit security-review
/config edit project
/permissions edit global
/instructions edit project
/spec edit
/plan edit
```

`/workflow edit` creates or reopens an isolated manual revision, opens that draft package, and
reviews it after the editor exits. It never edits the active workflow directly. Continue with
`/workflow review <name>`, `/workflow publish <name>`, or `/workflow discard <name>`.
Workflow names are validated before path construction, and the resolved active package and draft
must remain inside the selected project or global workflow root.

`/skill edit` opens the active user-authored skill's file or directory and reloads it after the
editor exits. Built-in skills are read-only because they have no user-owned source path.
Symlinked skill sources and directory skills containing symlinks are rejected before the editor
starts.

### Configuration and policy files

`/config edit [project|global]` opens `.cleetus/config.yaml` in the project by default, or the
global Cleetus configuration with `global`. Cleetus creates a comment-only file if the selected
file does not exist and validates the merged configuration after the editor exits. Configuration
is constructed by several startup services, so restart Cleetus to apply all changes.

`/permissions edit [project|global]` follows the same scope rules and creates `rules: []` when the
selected file does not exist. Cleetus validates and reloads both permission scopes immediately
after editing; the new rules apply to subsequent tool calls in the current session.

`/instructions edit [project|global|cleetus]` opens an instruction source and reloads the resolved
instruction text immediately:

- `project` selects the project's `.cleetus/instructions.md`.
- `global` selects `~/.config/cleetus/instructions.md`.
- `cleetus` selects the nearest project `CLEETUS.md` location.

When no scope is supplied, Cleetus opens the sole active instruction source. If none exists, it
creates the project source. If several sources contribute to the session, Cleetus lists them and
requires an explicit scope so the edit is not ambiguous. Project and `CLEETUS.md` sources cannot
be edited in a session started with `--no-project-instructions`.

### Specs and plans

`/spec edit [path]` opens the current pending spec when one exists. Otherwise it selects the newest
Markdown file in the configured specs directory (normally `docs/specs`). `/plan edit [path]` does
the same for `.cleetus/plans`. An explicit path must name an existing file inside the corresponding
artifact directory; these commands do not turn arbitrary files into specs or plans.
Containment is checked against real paths, so an in-directory symlink cannot redirect either
command to an external file.

The TUI completes editor-aware command stages with Tab or the suggestion picker. This includes
`edit` subcommands, valid configuration and instruction scopes, active workflow names,
user-authored skill names, and known spec/plan Markdown files. Artifact suggestions come only from
a bounded, non-recursive read of the configured project artifact directories and are displayed as
project-relative paths. Generic `/edit` deliberately does not discover filesystem paths; it only
completes the explicit `--create` and `--outside-project` options.

At the inline `Plan ready` approval prompt, press `e` to edit the pending plan before approval.
Cleetus reloads the saved text after the editor exits, so approval and subsequent execution use the
edited plan. This shortcut is available because normal slash-command input is suspended while the
approval prompt owns the terminal.

## Errors and current limits

Cleetus returns to its prompt and reports a readable error when both `$EDITOR` and `$VISUAL` are
unset, a target is missing, a create target already exists, a target escapes its owning root, an
unsafe editor command is configured, the editor cannot start, or it exits unsuccessfully.

V1 does not embed an editor, manage an editor server, or provide a persistent multiplexer pane.
It performs one foreground terminal handoff per `/edit` invocation.

See the [editor compatibility matrix above](#compatibility-matrix) for supported editor launch
patterns and known limitations.
