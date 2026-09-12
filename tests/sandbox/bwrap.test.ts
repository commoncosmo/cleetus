import { describe, expect, it } from "bun:test";
import { bwrapPrefix } from "../../src/sandbox/bwrap";
import type { SandboxPolicy } from "../../src/sandbox/policy";

const policy = (network: boolean): SandboxPolicy => ({
  writableExtra: ["/tmp", "/home/u/.npm", "/home/u/.cargo"],
  blockedDirs: ["/home/u/.ssh"],
  blockedFiles: ["/home/u/.netrc"],
  network,
});

/** Find the index of `flag` whose next two args equal a/b (a paired --bind/--ro-bind). */
function hasPair(argv: string[], flag: string, a: string, b: string): boolean {
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === flag && argv[i + 1] === a && argv[i + 2] === b) return true;
  }
  return false;
}

/** A single-arg flag check (`--tmpfs <dir>`). */
function hasSingleArgFlag(argv: string[], flag: string, a: string): boolean {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && argv[i + 1] === a) return true;
  }
  return false;
}

describe("bwrapPrefix", () => {
  const existAll = () => true;

  it("starts with bwrap, a read-only root, and dev/proc", () => {
    const argv = bwrapPrefix("/proj", policy(true), existAll);
    expect(argv[0]).toBe("bwrap");
    expect(hasPair(argv, "--ro-bind", "/", "/")).toBe(true);
    expect(argv).toContain("--dev");
    expect(argv).toContain("--proc");
    expect(argv).toContain("--die-with-parent");
    expect(argv).toContain("--unshare-pid");
    expect(argv[argv.length - 1]).toBe("--");
  });

  it("binds the project dir and existing writable dirs read-write", () => {
    const argv = bwrapPrefix("/proj", policy(true), existAll);
    expect(hasPair(argv, "--bind", "/proj", "/proj")).toBe(true);
    expect(hasPair(argv, "--bind", "/tmp", "/tmp")).toBe(true);
    expect(hasPair(argv, "--bind", "/home/u/.npm", "/home/u/.npm")).toBe(true);
  });

  it("skips writable dirs that do not exist", () => {
    const argv = bwrapPrefix("/proj", policy(true), (p) => p !== "/home/u/.cargo");
    expect(hasPair(argv, "--bind", "/home/u/.cargo", "/home/u/.cargo")).toBe(false);
    expect(hasPair(argv, "--bind", "/home/u/.npm", "/home/u/.npm")).toBe(true);
  });

  it("masks blocked dirs with tmpfs and blocked files with /dev/null", () => {
    const argv = bwrapPrefix("/proj", policy(true), existAll);
    expect(hasSingleArgFlag(argv, "--tmpfs", "/home/u/.ssh")).toBe(true);
    expect(hasPair(argv, "--ro-bind", "/dev/null", "/home/u/.netrc")).toBe(true);
  });

  it("skips blocked dirs and files that do not exist", () => {
    const argv = bwrapPrefix("/proj", policy(true), (p) => {
      return p !== "/home/u/.ssh" && p !== "/home/u/.netrc";
    });
    expect(hasSingleArgFlag(argv, "--tmpfs", "/home/u/.ssh")).toBe(false);
    expect(hasPair(argv, "--ro-bind", "/dev/null", "/home/u/.netrc")).toBe(false);
  });

  it("unshares the network only when network is false", () => {
    expect(bwrapPrefix("/proj", policy(true), existAll)).not.toContain("--unshare-net");
    expect(bwrapPrefix("/proj", policy(false), existAll)).toContain("--unshare-net");
  });

  it("overlays protected project metadata read-only", () => {
    const argv = bwrapPrefix(
      "/proj",
      { ...policy(true), protectedProjectPaths: [".git", ".cleetus"] },
      existAll,
    );
    expect(hasPair(argv, "--ro-bind", "/proj/.git", "/proj/.git")).toBe(true);
    expect(hasPair(argv, "--ro-bind", "/proj/.cleetus", "/proj/.cleetus")).toBe(true);
  });
});
