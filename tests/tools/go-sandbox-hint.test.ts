import { describe, expect, it } from "bun:test";
import { goToolchainSandboxHint } from "../../src/tools/go-sandbox-hint";

describe("goToolchainSandboxHint", () => {
  it("redirects GOCACHE when `go test` is denied writing the build cache", () => {
    // The exact denial a model saw fighting the sandbox in ctest/qwen1.
    const out =
      "# apple-scan\n" +
      "open /Users/example/Library/Caches/go-build/d3/d33133b7...-d: operation not permitted\nFAIL";
    const h = goToolchainSandboxHint("go test -v -run TestIsAppleOUI", out);
    expect(h).toContain("GOCACHE");
    expect(h).toContain("$(pwd)");
    // Must steer away from `go env -w`, which also writes outside the sandbox.
    expect(h).toContain("go env -w");
  });

  it("fires even when the command already carries an (insufficient) env prefix", () => {
    // Model set GOCACHE to a relative dir but still ran into the default cache — still Go, still denied.
    const out = "open /Users/example/Library/Caches/go-build/aa/bb-d: operation not permitted";
    expect(goToolchainSandboxHint("GOCACHE=./.gocache go build -o x .", out)).toContain("GOCACHE");
    expect(goToolchainSandboxHint("env GOCACHE=./c go test ./...", out)).toContain("GOCACHE");
  });

  it("redirects GOPATH to an in-tree subdir (not GOMODCACHE alone) when the module cache is denied", () => {
    // ctest/nemo3: `go get` blocked writing the module cache.
    const out =
      "go: writing stat cache: mkdir /Users/example/go/pkg/mod/cache/download/github.com/grandcat: " +
      "operation not permitted\ngo: downloading github.com/grandcat/zeroconf";
    const h = goToolchainSandboxHint("go get github.com/grandcat/zeroconf", out);
    // GOMODCACHE alone is insufficient — it moves pkg/mod but NOT pkg/sumdb. Steer to a GOPATH
    // subdir, which relocates both, plus GOCACHE.
    expect(h).toContain('GOPATH="$(pwd)/.gopath"');
    expect(h).toContain("GOCACHE");
    // Must still warn against the project-root GOPATH that breaks module resolution...
    expect(h).toContain("go.mod");
    // ...and must NOT repeat the earlier, insufficient GOMODCACHE-only advice.
    expect(h).not.toContain("GOMODCACHE");
  });

  it("also fires on the sumdb checksum-cache denial that GOMODCACHE would not have fixed", () => {
    // ctest/go1: with GOMODCACHE already set, `go get` still failed writing the sumdb cache,
    // which lives under $GOPATH/pkg/sumdb — the exact gap the corrected hint closes.
    const out =
      "go: downloading golang.org/x/net v0.57.0\n" +
      "go: golang.org/x/net/icmp: golang.org/x/net@v0.57.0: verifying module: open " +
      "/Users/example/go/pkg/sumdb/sum.golang.org/latest: operation not permitted";
    const h = goToolchainSandboxHint(
      'env GOMODCACHE="$(pwd)/.gomodcache" GOCACHE="$(pwd)/.gocache" go get golang.org/x/net/icmp',
      out,
    );
    expect(h).toContain('GOPATH="$(pwd)/.gopath"');
  });

  it("tells the model to set vars inline when `go env -w` itself is denied", () => {
    const out =
      "go: writing go env config: open /Users/example/Library/Application Support/go/env: " +
      "operation not permitted";
    const h = goToolchainSandboxHint("go env -w GOCACHE=$(pwd)/.gocache", out);
    expect(h).toContain("inline");
    expect(h).toContain("go env -w");
  });

  it("stays silent when the failure is not a sandbox write denial", () => {
    // A genuine compile/test failure must not be papered over with an environment hint.
    expect(
      goToolchainSandboxHint("go test ./...", "--- FAIL: TestX (0.00s)\n  want true, got false"),
    ).toBeNull();
    expect(goToolchainSandboxHint("go build .", "./main.go:5:2: undefined: foo")).toBeNull();
  });

  it("stays silent for non-Go commands and for a denial unrelated to a Go cache path", () => {
    // A write denial from a non-Go command, or a Go command denied on a path that is not a
    // toolchain cache, is a different problem — the generic boundary advisory already covers it.
    expect(
      goToolchainSandboxHint("touch /etc/hosts", "touch: /etc/hosts: operation not permitted"),
    ).toBeNull();
    expect(
      goToolchainSandboxHint(
        "go build -o /usr/local/bin/x .",
        "open /usr/local/bin/x: operation not permitted",
      ),
    ).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(goToolchainSandboxHint("", "operation not permitted")).toBeNull();
    expect(goToolchainSandboxHint("go test ./...", "")).toBeNull();
  });
});
