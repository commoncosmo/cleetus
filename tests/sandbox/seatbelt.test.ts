import { describe, expect, it } from "bun:test";
import type { SandboxPolicy } from "../../src/sandbox/policy";
import { seatbeltPrefix } from "../../src/sandbox/seatbelt";

const policy = (network: boolean): SandboxPolicy => ({
  writableExtra: ["/tmp", "/home/u/.npm"],
  blockedDirs: ["/home/u/.ssh"],
  blockedFiles: ["/home/u/.netrc"],
  network,
});

describe("seatbeltPrefix", () => {
  it("invokes sandbox-exec with an inline profile", () => {
    const argv = seatbeltPrefix("/proj", policy(true));
    expect(argv[0]).toBe("sandbox-exec");
    expect(argv[1]).toBe("-p");
    expect(typeof argv[2]).toBe("string");
    expect(argv.length).toBe(3);
  });

  it("allows writes to the project dir and writableExtra, denies others by default", () => {
    const profile = seatbeltPrefix("/proj", policy(true))[2];
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/proj")');
    expect(profile).toContain('(subpath "/tmp")');
    expect(profile).toContain('(subpath "/home/u/.npm")');
  });

  it("allows writes to standard safe character devices (/dev/null et al.)", () => {
    const profile = seatbeltPrefix("/proj", policy(true))[2];
    // /dev/null write is what build scripts (Stdio::null) and `2>/dev/null` need.
    expect(profile).toContain('(literal "/dev/null")');
    expect(profile).toContain('(literal "/dev/zero")');
    expect(profile).toContain('(literal "/dev/urandom")');
    expect(profile).toContain('(literal "/dev/tty")');
    // /dev/fd is a directory (fd passthrough), allowed as a subpath.
    expect(profile).toContain('(subpath "/dev/fd")');
    // Precise op: device writes use file-write-data, not blanket file-write*.
    expect(profile).toContain("(allow file-write-data");
  });

  it("does not blanket-allow all of /dev, and keeps deny-by-default for writes", () => {
    const profile = seatbeltPrefix("/proj", policy(true))[2];
    expect(profile).toContain("(deny file-write*)");
    expect(profile).not.toContain('(subpath "/dev")');
  });

  it("orders the device allow AFTER the write deny (SBPL is last-match-wins)", () => {
    // The entire fix depends on this ordering: if the device allow preceded
    // (deny file-write*), the deny would win and /dev/null would be blocked again.
    const profile = seatbeltPrefix("/proj", policy(true))[2]!;
    expect(profile.indexOf("(deny file-write*)")).toBeLessThan(
      profile.indexOf("(allow file-write-data"),
    );
  });

  it("denies reads of blocked dirs and files", () => {
    const profile = seatbeltPrefix("/proj", policy(true))[2];
    expect(profile).toContain('(deny file-read* (subpath "/home/u/.ssh"))');
    expect(profile).toContain('(deny file-read* (subpath "/home/u/.netrc"))');
  });

  it("adds a network deny only when network is false", () => {
    expect(seatbeltPrefix("/proj", policy(true))[2]).not.toContain("(deny network*)");
    expect(seatbeltPrefix("/proj", policy(false))[2]).toContain("(deny network*)");
  });

  it("places protected project metadata denies after the broad project allow", () => {
    const profile = seatbeltPrefix("/proj", {
      ...policy(true),
      protectedProjectPaths: [".git", ".cleetus"],
    })[2]!;
    const allow = profile.indexOf('(allow file-write* (subpath "/proj")');
    const gitDeny = profile.indexOf('(deny file-write* (subpath "/proj/.git"))');
    const cleetusDeny = profile.indexOf('(deny file-write* (subpath "/proj/.cleetus"))');
    expect(gitDeny).toBeGreaterThan(allow);
    expect(cleetusDeny).toBeGreaterThan(allow);
  });

  it("escapes embedded quotes and backslashes in paths", () => {
    const profile = seatbeltPrefix('/weird"path\\x', policy(true))[2];
    expect(profile).toContain('(subpath "/weird\\"path\\\\x")');
  });
});
