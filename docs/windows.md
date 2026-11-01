# Native Windows support

For editor integration, see [ACP setup and execution boundaries](acp.md).

## Installation and user data

Bootstrap from Windows PowerShell 5.1 or PowerShell 7:

```powershell
irm https://raw.githubusercontent.com/commoncosmo/cleetus/main/install.ps1 | iex
```

The script resolves the release tag once, verifies the selected x64/ARM64 ZIP
against that release's SHA-256 manifest, and preserves the complete MXC runtime
and notices. It installs without elevation, updates user and current-session
PATH, checks the executable version, and runs the quick doctor. Other open
terminals and editors need restarting to inherit PATH. An older command or alias
that shadows the installation is reported. The script does not install project
toolchains or change execution policy, Defender, or App Control settings.

| Location | Purpose |
| --- | --- |
| `%LOCALAPPDATA%\Programs\Cleetus\bin` | Executable, MXC runtime, and notices; managed by the installer |
| `%LOCALAPPDATA%\Cleetus` | Default global configuration, state, memories, recovery data, and caches |
| `%LOCALAPPDATA%\Cleetus\workspace` | Default `--global` workspace |
| `<project>\.cleetus` | Project configuration and history; stays with its project |

`CLEETUS_VERSION` selects a version such as `0.6.0`. `CLEETUS_INSTALL_DIR` selects
the application prefix (the script creates `bin` inside it). Script parameters
can also be passed explicitly:

```powershell
$installer = irm https://raw.githubusercontent.com/commoncosmo/cleetus/main/install.ps1
& ([scriptblock]::Create($installer)) -Version 0.6.0 -InstallDir 'D:\Apps\Cleetus' -NoPath
```

`-NoPath` leaves user and current PATH unchanged. `-SkipDoctor` skips the
post-install prerequisite report. `-TerminalProfile` optionally registers the
Cleetus Windows Terminal profile; it does not install Windows Terminal itself.
The equivalent environment flag is `CLEETUS_TERMINAL_PROFILE=1`, and source/local
installs accept `bun run install-local --terminal-profile`. Registration failures
are reported separately and do not roll back a successful binary installation.
Re-running the installer upgrades its managed
`bin` directory after staging and validation; data outside `bin` is preserved.
Close Cleetus and its child processes first. Locked executables cause a clear
failure before replacement, and failed directory replacement restores the old
`bin`. An existing unrelated `bin` directory is never taken over. Keep personal
files outside the managed `bin` directory.

### Migrating existing Windows installations

Existing `~/.config/cleetus` data remains active until explicitly migrated. If
only the legacy default `~/.cleetus` workspace exists, it is also retained until
migration. The doctor reports effective paths and legacy-mode guidance.
`cleetus --print-user-paths` prints path information as JSON without loading
providers or starting a sandbox.

```powershell
cleetus migrate-data          # preview only
# Close every other Cleetus instance, including editor ACP agents, before applying:
cleetus migrate-data --yes
```

Migration renames the complete config tree, including SQLite sidecars, to the
native data root and moves the old default workspace beneath `workspace`.
Explicitly configured custom workspaces and project-local data remain unchanged.
Global-workspace trust can require approval again after the path changes. Failed
moves are rolled back. Migration refuses populated destinations, linked source roots,
and cross-volume moves that cannot be performed safely. It never merges data.
While migration runs, a lock blocks new default-path sessions; after an interrupted
migration, inspect the reported lock and both paths before manually removing a
stale lock. Older Cleetus processes do not honor the new lock, so they must be
closed before migration.

When both old and new roots contain files, choose the intended root with
`--config-dir` and reconcile them deliberately. Explicit `--config-dir` always
wins. Linux and macOS keep their existing defaults.

### Portable mode

```powershell
$installer = irm https://raw.githubusercontent.com/commoncosmo/cleetus/main/install.ps1
& ([scriptblock]::Create($installer)) -Portable -InstallDir 'D:\Portable\Cleetus' -NoPath
```

The installer creates `cleetus.portable` at the application prefix. The layout is
`bin\cleetus.exe`, `bin\native\...`, and `data\...`. Portable configuration,
state, recovery data, and the default `data\workspace` follow that prefix when
the folder is moved, and upgrades preserve `data`. For a manually extracted ZIP,
place an empty `cleetus.portable` beside `cleetus.exe`; its `data` folder is adjacent.
`CLEETUS_PORTABLE=1` also enables portable mode; `CLEETUS_PORTABLE=0` overrides a
marker for the current process. Explicit config/workspace overrides still apply.
Portable mode does not import machine data automatically. OS temporary files,
project data, and external tool caches retain their own locations.

These installer and path behaviors require a build containing this change;
the previously published 0.6.0 binary retains the older config-path behavior.
Normal installs of older releases remain supported. Portable installs and
downgrades require the executable to confirm portable-path support before the
installer replaces anything; this prevents older binaries from ignoring the marker.

Native Windows execution uses MXC ProcessContainer, via the pinned 1.0.1 standalone
executor. The Node SDK is a build dependency only: the compiled CLI does not load
Koffi or require Node/Bun to be installed. An unpackaged PowerShell 7.4 or later
must be on PATH for native MXC execution.

## Required and recommended tools

Extract the **whole** matching Windows ZIP, keeping `native/` next to `cleetus.exe`.
Do not install MXC separately or copy a different MXC version onto PATH. Windows
itself must provide the serviced ProcessContainer capabilities used by the bundle.
See Microsoft's [Windows support matrix](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md).

| Component | Needed for | Recommendation |
|---|---|---|
| Updated Windows 11 | Native sandboxing | Required; the runtime capability probe is authoritative. |
| Unpackaged PowerShell 7.4+ (`pwsh.exe`) | Native agent commands | Required by Cleetus's host backend. Select an MSI or ZIP installation. WindowsApps/Store/MSIX PowerShell is rejected during native preflight; Windows PowerShell 5.1 is insufficient. |
| Configured inference endpoint | Agent responses | Required to use the agent; the server may run locally or remotely. See [providers](providers.md). |
| Git for Windows (`git.exe`) | Repository tools and checkpoints | Recommended baseline. Native Git is used; Git Bash is not a prerequisite. |
| Windows Terminal | Interactive TUI | Recommended; enables taskbar/tab progress integration. |
| Native ripgrep (`rg.exe`) | Faster content searches | Recommended for larger repositories. Cleetus has a built-in fallback and does not need Bash to discover ripgrep. |
| GitHub CLI (`gh.exe`) | GitHub operations | Optional. Install and authenticate only if those features are needed. |
| Editor | Opening files through `/edit` | Optional. Configure an appropriate editor command, for example `code --wait`. |
| Bun (`bun.exe`) and Microsoft Edge or Chrome | Self-contained browser verification | Optional for running Cleetus; required for native Windows `render_check`. Use the browser already installed, or set `CLEETUS_BROWSER` to its executable path. No Playwright download or project test dependencies are needed. |

PowerShell 7 installs alongside Windows PowerShell 5.1. Microsoft recommends
[WinGet for Windows clients](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows):

```powershell
winget install --id Microsoft.PowerShell --exact --source winget --installer-type wix
```

If WinGet has no applicable MSI for the machine's architecture, use an unpackaged
ZIP installation from the linked PowerShell installation guide. The Store version
may remain installed alongside it. Put the unpackaged installation first on PATH
and check `(Get-Command pwsh.exe).Source` in a new terminal. A WindowsApps alias and
its underlying packaged executable are both unsupported inside native MXC; Cleetus
does not silently substitute another installation or weaken containment.

Install Git from the [Git for Windows installation page](https://git-scm.com/install/windows).
Open a new terminal after installations so PATH changes are visible. Cleetus does
not automatically install tools or enable Windows features. Only the bootstrap
installer adds its own `bin` directory to PATH.

Project runtimes are separate from Cleetus's embedded runtime:

| Project markers | Tools to install when needed |
|---|---|
| `package.json`, package-manager field, or JS lockfiles | The project's Node.js/Bun version and npm/pnpm/Yarn/Bun package manager |
| `pyproject.toml` or `requirements.txt` | Python and the project's environment manager |
| `Cargo.toml` | Rust/Cargo; native dependencies may need Visual Studio Build Tools |
| `go.mod` | Go |
| Root `.sln`, `.slnx`, `.csproj`, `.fsproj`, or `.vbproj` | The appropriate .NET SDK |

Do not install every toolchain just to run Cleetus. The doctor recommends tools
based on root-level markers. It discovers these tools on PATH; presence does not
certify the version, every dependency, or every project command inside MXC. A
Python WindowsApps alias is reported as unverified rather than a working interpreter.

## Environment doctor and first run

```powershell
cleetus doctor --windows
cleetus doctor --windows --quick
cleetus doctor --windows --json
```

The doctor runs independently of normal agent startup and does not need a configured
model. It checks the bundled executor's PE architecture, MXC capabilities, and an
actual sandboxed PowerShell launch. It reports required prerequisites separately
from recommended and project-specific tools. It also checks configured providers'
model listings with a four-second deadline; provider URLs, API keys, and raw
connection errors are omitted from the report. Project configuration follows the
normal trust rules. No project hooks, package scripts, tests, or installation
commands are executed. Bash-dependent configured hooks produce a warning.

The full check creates a disposable `.cleetus-doctor-*` directory under the user's
home. It verifies allowed project writes, denied sibling writes, synthetic secret
read denial, `.git`/`.cleetus` read-only protection, and cancellation of a parent,
child, and grandchild. This cannot use the ordinary temp directory: the normal
sandbox policy deliberately permits temp writes. Fixtures are removed after the
check; if a recorded process survives, the directory is retained and reported.
The full doctor also verifies that discovered native Git starts inside MXC.

`--quick` skips synthetic enforcement/process tests and sandboxed Git. It still
checks native prerequisites and configured providers. Exit codes are **0** when
no required check failed, **1** for required failures, and **2** for command usage
errors. Recommended/project-tool and provider warnings do not change the exit
code. A passing environment report with no provider configured is not a claim
that the agent is ready to answer prompts.

On the existing first-run path (no providers configured), native Windows prerequisites
are checked before provider discovery or starter-config writes. Missing required
tools stop setup with repair instructions. Optional tools only produce recommendations.
The same checks precede the no-provider error in ACP mode, with diagnostics on stderr
so stdout remains reserved for the protocol. Existing configured sessions retain
their normal sandbox health check; full doctor tests do not run on every launch.
Docker first-run setup does not require native MXC/PowerShell, and an explicit
`sandbox.backend: none` skips MXC while still checking native PowerShell.

For source/development runs, point the doctor at a staged executor explicitly:

```powershell
bun src/bin/cleetus.ts doctor --windows --executor dist/cleetus-windows-arm64/native/wxc-exec.exe
```

Normal compiled distributions use only their adjacent executor, never a helper
discovered on PATH. These checks diagnose the environment; they do not complete
the remaining Windows security and toolchain compatibility work listed below.

Windows must have serviced ProcessContainer and denied-path support. Cleetus probes
these at startup, then starts a harmless PowerShell command. A requested Windows
host sandbox fails closed if either check fails. The native backend does not fall
back to WSL, Git Bash, or unsandboxed execution.

```powershell
bun install --frozen-lockfile
$env:CLEETUS_TARGET = 'bun-windows-arm64' # or bun-windows-x64
bun run build
./dist/cleetus-windows-arm64/cleetus.exe --version
bun scripts/smoke-windows.ts
```

Build with the repository's pinned Bun 1.3.14. Each Windows build gets its own
directory containing `cleetus.exe`, `native/wxc-exec.exe`, MXC's license, and native
software inventory. Release jobs ZIP the complete directory plus Cleetus notices.
Keep the native directory with the executable when installing or moving it.
`bun run install-local` also copies that runtime directory.

## Execution and policy

The legacy tool name `bash` uses native PowerShell on Windows. Its description and
environment instructions tell the model which syntax to use. Profiles are disabled.
PowerShell cmdlet errors terminate the command. Native failures allow the output
pipeline to drain before Cleetus reports failure, preserving compiler/test diagnostics
behind trailing filters. Later logging commands can run, but cannot erase an earlier
native failure. Use `&&` for dependent operations. This needs PowerShell 7.4+.
The trusted PowerShell wrapper reports preserved exit status to verification tracking,
so successful logging cannot hide a failed native test/build command. npm scripts,
`npm test`, npx verifiers, and equivalent pnpm/Yarn commands are tracked alongside Bun.
Git, ACP diagnostics/formatters, and workflow `command.run` use direct argv where
the backend supports it. Existing Bash-authored hook/configured-command strings
need PowerShell equivalents. The Docker backend retains its Linux/Bash contract.

The policy allows broad reads, denies known home-relative secret paths, and permits
writes to the project, Windows temp, and existing package caches. Model shell calls
add read-only restrictions for existing `.git` and `.cleetus`; trusted Git/checkpoint
operations can write those locations. As with other backends, file tools run in the
host and still depend on application-level path and permission guards.
The native launcher directory and running Cleetus executable are read-only even
when a development build lives inside the project.

MXC owns the contained process tree. Timeout, cancellation, and sandbox disposal
kill the executor; its native lifetime boundary reaps descendants. The smoke test
checks actual parent/child/grandchild PIDs rather than assuming the executor's exit
proves cleanup. Windows does not use Unix negative-PID process-group signaling.

Each native sandbox session also gets a private scratch directory under the host
temp directory. Cleetus grants it write access and supplies `TEMP`, `TMP`, `TMPDIR`,
`BUN_TMPDIR`, `BUN_INSTALL_CACHE_DIR`, and `BUN_RUNTIME_TRANSPILER_CACHE_PATH` for
contained commands. The PowerShell wrapper restores its temp variables after MXC
initialization. `BUN_INSTALL` and installed tool locations are not redirected.
Scratch/cache contents last for the session and are removed after its processes
finish; an OS lock can defer cleanup with a warning. Explicit per-command environment
overrides remain subject to the sandbox's filesystem grants. Never put tool caches
under the protected `.cleetus` control directory.

PowerShell commands flush their complete output pipeline to plain text before
exiting, including mixed location/listing objects. Progress is disabled; serialized
CLIXML errors remain readable without host/progress metadata. When MXC appends a
packaged-app diagnosis after workload output, Cleetus drops that redundant trailer
and preserves the actual error and exit status. It does not recommend doctor for
invalid flags, missing paths, or other ordinary command errors. A launch diagnosis
without workload output is preserved. Process-launch denials are reported separately
from filesystem write denials.

UI subsystem initialization is permitted with container UI isolation, clipboard
disabled, and input injection disabled. This is necessary for these console runtimes
to initialize. Git Bash still fails on MSYS named-object initialization; see
[upstream issue 1061](https://github.com/microsoft/mxc/issues/1061).

## Scaffolding recovery

Use the `scaffold` tool for project generators. It runs in an empty scratch
directory and merges verified output while preserving `.git` and `.cleetus`.
A generator that prints cancellation or produces no files is a failed scaffold
even if its exit code is zero. Known Vite invocations must also produce recognizable
project files. Timed-out/cancelled runs never merge output.

For simple recognized Windows Vite commands, Cleetus adds `--no-interactive` and
`--no-immediate`. If a Bun invocation fails specifically on temp-directory access,
the tool may retry once with `npx --yes` using the same generator version/template
in a fresh scratch directory. This fallback is disabled for Bun-managed projects
(Bun lockfile or `packageManager: bun@...`) and never applies to compound/custom
commands. The recovery is reported in the tool result. It does not create a nested
project or require the model to move/delete directories manually.

The full doctor additionally tests deliberate exit-code/exception/parser failures,
Bun temp/cache file I/O, and offline `bun x`/`bunx` fixture execution where installed.
The offline checks do **not** certify registry downloads or every package installer.
Our real Vite smoke test still encountered a Bun package-install temp failure and
recovered through the bounded npm path. Repeat that opt-in network test with
`bun scripts/smoke-windows-scaffold.ts`; it writes only to its own `dist/scaffold-smoke`
project and downloads the pinned generator. `ctest` is not used or modified.

## Private configuration, state, and Windows paths

Windows private-state writes use the OS-shipped Windows PowerShell/.NET ACL APIs,
independently of the PowerShell selected for agent commands. They do not require
administrator elevation or a separate utility, and do not change execution policy.
The DACL grants Full Control only to the current user's SID, LocalSystem, and
BUILTIN Administrators. Inheritance from permissive parents is disabled; private
directories supply inheritable rules for new children, and existing private trees
are tightened when opened through the directory helper. This protects data from
other ordinary local accounts, not administrators or processes already running as you.

The global data root's `workspace` child is a source workspace: it inherits the
root's permissions, but Cleetus does not recursively replace its explicit ACLs or
walk dependency junctions there. Linked private-state entries remain refused.

New private files receive their ACL at creation, before content is written.
SQLite databases and their WAL/SHM sidecars are prepared privately before SQLite
opens them. Config/state writes, saved permissions, trust records, attachments,
and memory use the shared protections. Application-owned roots are secured without
changing the project/source parent. Data migration secures the destination before
reporting success and rolls back directory moves if protection fails.

Use a filesystem/location supporting Windows ACLs, with entries owned by your
account, SYSTEM, or Administrators. Private-state junctions, symbolic links, hardlinked
files, and linked parent paths are refused. An ACL failure stops the operation;
Cleetus never treats a successful `chmod` as Windows privacy protection or writes
secret content through an unprotected fallback.

Home expansion accepts `~\notes` and `~/notes` on Windows. Editor commands preserve
native backslashes and quoted paths with spaces; use quotes around a path containing
spaces rather than Bash-style backslash escaping. Path containment handles drive
boundaries, UNC shares, case variants, and Windows namespace prefixes. Secret guards
also cover `%APPDATA%\gcloud`, `%APPDATA%\gnupg`, and `~\_netrc`, alongside the
existing home-relative locations. Native backslash glob patterns are normalized
before matching and checked for wildcard-tail traversal.

The `windows-state` CI workflow exercises native ACLs, SQLite sidecars, and path
regressions on x64 and ARM64 runners; it does not claim MXC enforcement coverage.

## Windows Terminal

Install or remove the optional profile without changing Terminal's main settings:

```powershell
cleetus terminal install
cleetus terminal uninstall
```

Cleetus manages only its marked fragment at
`%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\Cleetus\Cleetus.json`.
Registration is repeatable and updates that profile to the selected executable.
Existing unmarked fragments, files with additional profiles/settings, junctions,
and hardlinks are left untouched with an error. Older manually generated fragments
should be reviewed and moved aside before registering the managed profile.
Other files and Terminal settings are never removed. Restart all Terminal windows
after registration/removal so the profile list reloads. The optional installer
flag registers the same profile; registration needs a build supporting these commands.

The dropdown profile launches Cleetus directly with `--global`, using its configured
managed global workspace. Its bootstrap directory is `%USERPROFILE%`, so a Terminal
started from a shortcut cannot accidentally use `C:\Windows\System32` as a project.
Explicit `terminal open <project>` commands still start project-scoped sessions in
the requested directory and do not use the dropdown's `--global` argument.
For source runs, it retains Bun plus the source entry point. You can choose a
particular compiled installation with
`cleetus terminal install --executable C:\Apps\Cleetus\bin\cleetus.exe`.
Moving an installation afterward requires re-registering its profile.

Open projects in the most recently used Terminal window (or a new window if none exists):

```powershell
cleetus terminal open 'C:\Projects\my app'
cleetus terminal open 'C:\Projects\my app' --split
cleetus terminal open --split  # use the current directory
cleetus terminal open 'C:\Projects\my app' --split --vertical --size 0.65
cleetus terminal open 'C:\Projects\my app' --split --horizontal --size 0.4
```

`--vertical` creates side-by-side panes; `--horizontal` creates stacked panes.
Choose at most one orientation. Without either flag, Terminal chooses automatically.
`--size` sets the new pane's initial share of the currently focused pane's area,
from `0.01` to `0.99` inclusive; `0.65` means 65%. Omitting it retains Terminal's
default split size. Orientation and size require `--split`, and all pane options
apply only to `terminal open`. Panes remain resizable after opening: focus a pane
and use **Alt+Shift+Left/Right** for width or **Alt+Shift+Up/Down** for height.

These launch Cleetus with explicit argv, without a PowerShell command string and
without requiring the optional profile first. Spaces, apostrophes, and Unicode in
project paths are supported. Semicolons and control characters are refused because
`wt` interprets semicolons as additional actions, including inside argument values.
Missing Terminal, missing directories, and launch failures produce Terminal-specific
errors rather than provider or MXC diagnostics. Bun cannot resolve WindowsApps
execution aliases, so discovery also uses the OS-shipped PowerShell's read-only
installed-package metadata to locate stable Terminal or Terminal Preview. Neither
that lookup nor profile registration changes shell profiles or execution policy.

The interactive TUI reports the session's project directory (OSC 9;9), a sanitized
project title, and trusted progress state (OSC 9;4). Titles distinguish working,
waiting for input, and idle sessions. Permission prompts, plan/build/task-list
decisions, spec revision, pickers, and editor approvals all request attention.
New tabs using directory inheritance can reuse the session root; transient tool
working directories never change it. Idle/unmount/normal process exit clears the
progress state. Terminal profiles with application titles suppressed may ignore
title changes; the managed profile enables them.

Metadata is emitted only with a TTY and `WT_SESSION`. ACP and redirected output
receive no integration sequences. Set `CLEETUS_TERMINAL_INTEGRATION=0` to disable
all metadata, or `CLEETUS_TERMINAL_PROGRESS=0` to disable only progress. Windows
directory reporting requires a native drive/UNC path. The developer-only fragment
generator remains available as `bun scripts/windows-terminal-profile.ts <exe>`.

Windows Terminal is the terminal host; PowerShell remains the shell for agent
commands. Opening a Cleetus pane retains ordinary startup, approvals, and MXC
enforcement. This does not create an interactive agent shell. OSC 133 transcript
navigation and interactive MXC/ConPTY terminals are tracked in
[issue #37](https://github.com/commoncosmo/cleetus/issues/37).

## Verification and remaining coverage

Native `render_check` accepts existing npm, pnpm, Yarn, and Bun dev/preview scripts.
It launches the server and a disposable headless browser inside one MXC execution,
checks text, interactions, and requested computed styles, then stops the entire tree.
Cancellation and timeout use the same lifetime boundary. A missing browser/runtime
is reported as unavailable verification, rather than a broken application. Browser
profiles use the sandbox's disposable scratch directory. `smoke_run` also stops its
processes when its observation window ends; it does not retain a background server.
After a fixed browser/runtime prerequisite failure, the runtime stops repeated
render, background-server, and localhost-probe workarounds before asking permission
or executing them. Build checks and code work remain available. A new user turn can
retry after the prerequisite is repaired; cold-server readiness and observed app
defects do not activate this stop.
Completion audits reserve four tool attempts for repair and verification instead of
spending the whole budget on inspection. If an audit is cut short, its final summary
uses recorded edits/checks and identifies blocked edit requests as unexecuted. A
navigation check must click the link and verify destination content; an initial-page
heading or applied layout utilities alone do not establish route transitions.

Shell tool `timeoutMs` values are milliseconds, with a minimum of 1000 and a default
of 120000. Use 30000 for 30 seconds. Smaller/invalid values are rejected before a
process starts; Cleetus does not guess that a value meant seconds. Ordinary timeout
messages give timeout guidance; recognized dev-server commands also get lifecycle
guidance. Internal process/cancellation probes can still use shorter deadlines.

For static scaffolds, use `expectedText` for the heading and `expectStyled: true`.
`expectedControl` identifies an interactive button, link, input, or focusable control.
Required interactions must retain their assertions; missing-control guidance does
not turn a failed interaction into a passing check.

After a successful npm scaffold recovery, Cleetus records npm in
`package.json`'s `devEngines.packageManager.name`. Explicit `packageManager` selections
take precedence, followed by that recovery selection and existing lockfiles. Simple
Bun install/add/remove/run commands are translated to the selected package manager;
Common output-trimming pipelines retain the same translation; arbitrary Bun programs
and other compound shell commands are left intact. Build, quality,
and test script detection share the same selection. Bootstrap-only requests skip
automatic TDD; requested application behavior still receives test-first guidance.

Transient model connection failures, including pre-response `ECONNRESET`, receive
one automatic retry after a brief cancellable delay. Completed tool work is retained;
cancellation and invalid requests are not retried. This can recover a dropped socket,
but cannot repair a stopped inference server.

`bun scripts/smoke-windows-render.ts` exercises native browser text/style/interaction
checks, missing-browser diagnostics, and cancellation, including verifying the server
PID is gone after teardown.

`bun scripts/smoke-windowsapps-powershell.ts <WindowsApps-pwsh.exe>` verifies the
actual Store installation's host output, reproduces the SDK's root/nested packaged
launch restriction, and checks Cleetus's early prerequisite/render rejection. The
ct4 regression used `Microsoft.PowerShell_7.6.8.0_arm64__8wekyb3d8bbwe` on this host.

`scripts/smoke-windows.ts` compiles a fixture, stages the production executor, and
checks PowerShell, direct Git, write restrictions, a synthetic secret denial,
metadata protection, pipeline failure, stdin, local network allow/deny, cancellation
descendants, and timeout.
Set `CLEETUS_SMOKE_ARCH=x64` to exercise the x64 executor and fixture on an ARM64
Windows host with x64 emulation. That is not a physical x64 machine test.

Local validation used Windows build 28000 with Bun 1.3.14. Physical x64 coverage,
full interactive Terminal rendering, broader development-tool compatibility,
and additional Windows path/toolchain edge cases still need dedicated coverage
before treating the entire Windows port as complete. Private-state ACL and core
Windows path regressions have dedicated native coverage as described above.
CI builds Windows artifacts but does not certify MXC enforcement on its hosted OS.
