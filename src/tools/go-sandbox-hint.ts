import { looksLikeWriteDenial } from "../sandbox/boundary";

/**
 * Reactive hint for a Go command that failed because the toolchain tried to write a cache OUTSIDE
 * the project, which the sandbox blocks. Go defaults its build cache, module cache, and env-config
 * to `$HOME` (`~/Library/Caches/go-build`, `~/go/pkg/mod`, `~/Library/Application Support/go/env`),
 * so `go test`/`go build`/`go get` fail with "operation not permitted" until those are redirected
 * into the project tree. Models otherwise burn many turns rediscovering this by trial (observed in
 * ctest/qwen1 and ctest/nemo3), and some break module resolution by setting GOPATH to the project.
 *
 * Pure; never throws on ordinary string input. Gated on BOTH the OS write-denial signature and a
 * Go toolchain-cache path in the output, so an ordinary compile/test failure gets no hint and a
 * write denial from a non-Go command is left to the generic boundary advisory.
 */

/** A Go invocation, allowing a leading env prefix (`env GOCACHE=… go test`, `FOO=1 go build`). */
const GO_INVOCATION = /\bgo\s+(?:test|build|run|get|mod|install|vet|generate|env)\b/;

/** Denied Go env-config write — the `go env -w` path. */
const GO_ENV_CONFIG = /writing go env config|[/\\]go[/\\]env\b/i;
/** Denied Go module-fetch write: the module cache (`pkg/mod`) or the sumdb checksum cache
 *  (`pkg/sumdb`). Both live under GOPATH, so both are blocked together and fixed together. */
const GO_MODULE_CACHE = /[/\\]pkg[/\\](?:mod|sumdb)\b/i;
/** Denied Go build-cache write. */
const GO_BUILD_CACHE = /[/\\]go-build\b/i;

const GOCACHE_FIX =
  'redirect it into the project and run inline: env GOCACHE="$(pwd)/.gocache" <your go command>. ' +
  "`go env -w` cannot help — it writes its config outside the sandbox too.";

export function goToolchainSandboxHint(command: string, errorOutput: string): string | null {
  if (command.length === 0 || errorOutput.length === 0) return null;
  if (!looksLikeWriteDenial(errorOutput)) return null;
  if (!GO_INVOCATION.test(command)) return null;

  // `go env -w` itself was blocked: the fix is to stop using it, not to redirect it.
  if (GO_ENV_CONFIG.test(errorOutput) || /\bgo\s+env\s+-w\b/.test(command)) {
    return (
      "Hint: `go env -w` writes a config file outside the project sandbox, which is blocked. " +
      'Set the variable inline on each command instead: env GOCACHE="$(pwd)/.gocache" <your go command>.'
    );
  }

  // Module download was blocked (`go get`, `go mod tidy`, first build of an external dep). Fetching
  // writes to two caches under GOPATH — the module cache (pkg/mod) AND the sumdb checksum cache
  // (pkg/sumdb) — so GOMODCACHE alone is not enough (it moves only pkg/mod). Relocate GOPATH to an
  // in-tree SUBDIR, which moves both, and set GOCACHE too.
  if (GO_MODULE_CACHE.test(errorOutput)) {
    return (
      "Hint: fetching Go modules writes to caches outside the project sandbox (the module cache " +
      "and the sumdb checksum cache), so the download was blocked. Point GOPATH at an in-tree " +
      'subdir — this relocates both — and set GOCACHE: env GOPATH="$(pwd)/.gopath" ' +
      'GOCACHE="$(pwd)/.gocache" <your go command>. Do not set GOPATH to the project root (the ' +
      "directory holding go.mod), which makes Go ignore your go.mod."
    );
  }

  // Build cache was blocked (the common `go test` / `go build` case).
  if (GO_BUILD_CACHE.test(errorOutput)) {
    return `Hint: Go's build cache defaults outside the project sandbox, so the write was blocked — ${GOCACHE_FIX}`;
  }

  return null;
}
