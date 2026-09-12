# Contributing

cleetus uses [Bun](https://bun.sh) — not Node, npm, yarn, or pnpm. Use `bun`,
`bunx`, and `bun run` for everything (installing, running scripts, one-off
tools).

## Before you push

CI (`.github/workflows/ci.yml`) gates on three checks. All three must pass, so
run them locally before pushing — in the same order CI does:

1. **Lint** — `bun run lint` (biome). `bun run format` applies the safe
   formatting/import-sort fixes.
2. **Typecheck** — `bun run typecheck` (`tsc --noEmit`). Note that **`bun test`
   does not type-check** — it transpiles and runs, so a type error passes the
   test suite but still fails CI's typecheck job. Never skip this step.
3. **Test** — `bun test` (the full suite).

A green test suite alone is not "done": lint errors or type errors still fail
CI.

## Licensing

By submitting a contribution to this repository, you agree that it may be
distributed under the [MIT License](LICENSE).

When changing JavaScript dependencies or the pinned Bun runtime, run `bun run licenses` and commit
the regenerated
`THIRD_PARTY_NOTICES.txt`. CI rejects stale notices, unreviewed license
expressions, and dependencies that omit a license notice without a reviewed
override. If the bundled dependency graph changes, review and update the
per-platform inventory in `scripts/license-overrides/npm-packages.json` before
regenerating the notices.
