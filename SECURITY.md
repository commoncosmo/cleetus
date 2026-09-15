# Security policy

Only the latest release receives security fixes. Upgrade rather than relying on an older binary;
source and dependency fixes require a rebuilt release. Versions before 0.5.1 do not include the
project-configuration trust gate and symlink-write hardening.

## Reporting vulnerabilities

Do not disclose vulnerabilities, credentials, or exploit details in public issues or pull requests.
Use GitHub's **Security → Report a vulnerability** private reporting flow when available. While
this repository is private and that feature is unavailable, use your existing private channel to
a repository maintainer. Maintainers must enable and verify private vulnerability reporting before
making this repository public.

## Trust boundaries and limitations

- Run `cleetus trust` to list the fingerprints of project configuration. Review
  `.cleetus/config.yaml` and `.cleetus/permissions.yaml` before approving them with
  `cleetus trust --yes`. Use the same `--config-dir` as your normal launch. The trust store must
  be outside the project. Changed configuration or a different project location requires approval
  again; loading never grants trust automatically, including noninteractive/ACP execution.
- Configuration is executable authority: trusted MCP servers and hooks can run code, and trusted
  configuration can select providers, permissions, and sandbox behavior. Only approve projects
  and MCP implementations you trust. MCP processes are not confined by the Bash sandbox.
- MCP receives a small process-environment allowlist. Supply needed credentials explicitly through
  that server's `env` configuration, using `${VARIABLE}` interpolation instead of committing secrets.
  This limits accidental inheritance; it does not make malicious MCP servers safe.
- ACP saved Bash approvals authorize an exact command in an exact resolved working directory.
  Changed arguments, shell operators, substitutions, or working directories require approval again.
  Global/project manually authored permission rules remain powerful policy: inspect broad allows.
- Generic file writers reject symlink aliases and `.git`/`.cleetus` metadata writes. Use real file
  paths and dedicated control commands. These checks and final-component no-follow opens are defense
  in depth, not a claim of race-free confinement against a hostile concurrent local process.
- The host sandbox protects subprocess writes and selected credential locations. MCP, providers,
  editors, and in-process tools have separate boundaries. Shell subprocesses still inherit their
  launch environment: do not start Cleetus with unrelated credentials exported. Network is enabled
  by default. Linux without working bubblewrap and Windows can fall back to an explicitly displayed
  degraded, unsandboxed mode. `none` and permission-disabled modes are for trusted work only.
- Cleetus-owned state directories and private databases/config/attachments use restrictive local
  permissions. This is not encryption and does not protect against processes running as your user.

CI checks dependencies and Git history for known vulnerabilities/secrets. Release signing waits
for quality and security checks on the tagged commit. No scanner guarantees absence of bugs.
