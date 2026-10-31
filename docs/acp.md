# Agent Client Protocol

Run `cleetus acp` as an ACP v1 agent from a compatible editor or other client.
Configure providers and approve project configuration from a terminal first;
ACP launches use the same project trust checks as the CLI.

Strata uses the same provider configuration in ACP as in the terminal: configure
`type: strata`, the root `base_url` without `/v1`, and the served model ID (for example
`iq3_s`). You can select it with `cleetus acp --provider strata --model iq3_s`, where
`strata` is your configured provider name. Model-label family detection and the optional
`context_length` fallback apply to ACP sessions too. See [Strata setup](providers.md#strata).

Configure the client to launch the executable directly. A representative agent
entry on Windows looks like this; the surrounding configuration is client-specific:

```json
{
  "command": "C:\\Users\\you\\AppData\\Local\\Programs\\Cleetus\\bin\\cleetus.exe",
  "args": ["acp"]
}
```

Use an absolute executable path if the editor does not inherit your terminal's
PATH. Optional launch arguments include `--config-dir`, `--provider`, `--model`,
and `--verbose`; see `cleetus acp --help`. No PowerShell wrapper is required to
launch the protocol server. stdout contains only newline-delimited JSON-RPC;
diagnostics go to stderr.

On Windows, GUI editors may retain a different PATH from your terminal. Use
`--shell-executable` to pin an unpackaged PowerShell installation explicitly:

```json
{
  "command": "C:\\Users\\you\\AppData\\Local\\Programs\\Cleetus\\bin\\cleetus.exe",
  "args": ["acp", "--shell-executable", "C:\\Tools\\PowerShell 7\\pwsh.exe"]
}
```

Use an absolute path to `pwsh.exe`, with no extra quote characters in the JSON
argument. This selects PowerShell for MXC preflight, every session's local shell,
client-terminal commands, and browser verification. It overrides PATH without
changing the editor's environment. MXC still requires an unpackaged PowerShell
7.4+ MSI or ZIP; pointing this option at WindowsApps/MSIX does not bypass that
restriction. The option currently supports Windows local host/none backends;
Docker shell selection is separate. Omitting it preserves PATH-based selection.

## Windows prerequisites and execution boundaries

Use the complete Windows distribution, including the shipped
`native/wxc-exec.exe`. Run `cleetus doctor` from a terminal before configuring
the editor. See [Windows setup](windows.md) for the supported Windows version,
unpackaged PowerShell 7.4+, and optional development tools. The release includes
its MXC executor; a separate MXC installation is unnecessary. Restart editors
after changing PATH.

Command execution depends on the capabilities the client advertises:

| Client capability | Execution boundary |
| --- | --- |
| No terminal capability | Cleetus uses its configured local sandbox. On Windows, `sandbox.backend: host` uses native MXC, with a sandbox rooted at each session's project directory. |
| Terminal capability | Commands run through the client's terminal API. The client owns containment and process-tree cleanup; Cleetus's local MXC restrictions do not apply to those commands. Cleetus reports this boundary on stderr. |

Client-terminal failures never cause a retry through local execution. Local
sandbox prerequisites are still checked at ACP startup. A Store or WindowsApps
PowerShell installation is unsuitable for local MXC; install an unpackaged MSI
or ZIP alongside it and put that `pwsh.exe` first on PATH.

Windows commands use PowerShell. Application-generated commands preserve argv,
environment overrides, and the session's absolute working directory. ACP v1 has
no stdin-write operation, so Cleetus bridges supplied text stdin through a
PowerShell child process. The client must run on the same Windows host and have
the required executables available. Cross-platform remote terminals are not
negotiated.

## Command approvals

Shell prompts offer an exact-command session approval and, for simple commands, a
suggested argument pattern such as `bun test *`. The pattern choice states the
working directory, shell, and whether it lasts for this session or is saved to the
project. It covers future matching calls without approving a different subcommand.

Use these commands between turns for a custom pattern:

```text
/permissions
/permissions allow session bun test tests/*.test.ts --timeout 30000
/permissions allow project bun test *
/permissions remove project bun test *
```

Scopes are `session`, `project`, and `global`. Saved global command rules still
apply only to their recorded working directory and shell. Removal targets the
same pattern, current working directory, shell, and scope. Project saves update
Cleetus's external trust record; external file edits still require project reapproval.
Session rules belong to this live ACP session and are not persisted across ACP
process restarts or restored from saved conversation history.

Clients advertising `clientCapabilities.elicitation.form` also get an **Edit command
approval pattern** option. Cleetus sends an `elicitation/create` form, validates the
response, then asks for a separate permission confirmation showing the complete rule.
Declining, cancelling, disconnecting, or returning an invalid response never grants
permission. Clients without form support use the suggested choices or `/permissions`.
No particular editor's form support is assumed.

`*` inside an argument matches part of that argument; a standalone `*` matches zero
or more arguments. The executable stays fixed; dispatchers such as Bun, npm, and Git
also keep their subcommand fixed. Shell operators, substitutions, redirections,
control characters, and interpreter payloads require ordinary per-call approval.
Complex quoting/escaping may also fall back to a prompt. These are command approvals,
not guarantees about a program's effects: approved scripts, tests, and options can
execute code. Cleetus's normal execution boundaries and non-overridable guards remain.

Saved `command_pattern` rules are shared with CLI Cleetus and bind `command_cwd`
and `command_shell`. Legacy `args_pattern` rules retain their trailing-prefix behavior;
legacy broad allow rules continue to require ACP client approval. See
[Permissions](../README.md#permissions) for the terminal editing flow.

## Cancellation, sessions, and files

Command deadlines and `session/cancel` stop waiting for terminal completion,
request terminal termination, collect available output, and release the terminal.
The client must implement termination of the entire process tree. If it does not
confirm cleanup, the tool reports that limitation. Closing the protocol input
cancels active and queued turns and rejects outstanding client requests.

One connection can contain sessions for different project directories. Local
sandbox instances and project services are cached by canonical project path;
turns run through a connection-wide queue so their adapters cannot overlap.
Each session keeps its own permissions. Global and scratch launches intentionally
pin the session working directory to their launch workspace.

When the client advertises filesystem capabilities, `read_file` and `write_file`
use its corresponding text-file APIs. Other filesystem tools operate on disk;
save editor buffers before running builds or disk-based edits.

Native Windows `render_check` requires Bun plus Edge or Chrome on the executing
host. It checks the page and requested interactions and tears down its temporary
server. It does not keep a preview server running after verification.

## Validation

`bun test tests/acp` covers protocol handling, permissions, file bridges, session
isolation, terminal lifecycle, and disconnect cancellation. On a Windows machine
with the prerequisites installed, build and run the native integration harness:

```powershell
$env:CLEETUS_OUT = 'dist/acp-smoke/cleetus.exe'
bun run scripts/build.ts
bun run scripts/smoke-windows-acp.ts
```

The harness uses a deterministic local model endpoint and a simulated ACP client
that starts real Windows processes. It verifies the compiled executable in MXC
and client-terminal modes, project paths containing spaces and Unicode, argv,
stdin, environment forwarding, timeouts, child-process cancellation, browser
interaction, and protocol-only stdout. It complements testing in a real editor.
