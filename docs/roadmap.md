# Cleetus roadmap

Cleetus is pre-1.0 software. The CLI, terminal UI, ACP server, local-model providers, tools,
skills, workflows, sessions, and project-scoped configuration are implemented. Interfaces and
configuration may change before a stable release.

## Current priorities

- Publish a reviewed open-source release with a clear contributor experience.
- Validate reproducible CLI builds and release artifacts across supported macOS and Linux targets.
- Improve reliability for local models through focused verification, recovery, and provider
  compatibility work.

## Areas under consideration

These are directions for exploration, not commitments or release dates:

- ACP-native orchestration for clients that can present progress, permissions, and cancellation
  clearly.
- Richer multimodal input and attachment handling.
- A `cleetus update` command for managed binary updates.
- Further editor integration after real-world use identifies a concrete limitation in the current
  terminal handoff.

## Release readiness

Before making a public release, complete the items in the
[public release checklist](public-release-checklist.md). Current behavior, tests, and user
documentation take precedence over this roadmap.
