import { describe, expect, it } from "bun:test";
import { isAcpInvocation } from "../../src/acp/invocation";

describe("isAcpInvocation", () => {
  it("is true when the first user token is acp (bun-dev argv layout)", () => {
    expect(isAcpInvocation(["bun", "/p/src/bin/cleetus.ts", "acp"])).toBe(true);
  });

  it("is true for the compiled-binary argv layout ([exe, exe, ...args])", () => {
    expect(isAcpInvocation(["/usr/local/bin/cleetus", "/usr/local/bin/cleetus", "acp"])).toBe(true);
  });

  it("is true when acp is followed by options", () => {
    expect(isAcpInvocation(["bun", "s", "acp", "--provider", "lmstudio"])).toBe(true);
  });

  it("is false for a bare invocation (interactive TUI must not be hijacked)", () => {
    expect(isAcpInvocation(["bun", "s"])).toBe(false);
  });

  it("is false for a one-shot prompt (must not be read as a subcommand)", () => {
    expect(isAcpInvocation(["bun", "s", "fix the bug"])).toBe(false);
  });

  it("is false for a flag-first invocation", () => {
    expect(isAcpInvocation(["bun", "s", "--resume"])).toBe(false);
  });

  it("is false when acp appears only as a later token, not the command", () => {
    expect(isAcpInvocation(["bun", "s", "explain", "acp"])).toBe(false);
  });
});
