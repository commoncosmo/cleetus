import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPolicy } from "../../src/sandbox/policy";

describe("buildPolicy", () => {
  const home = "/home/u";

  it("always allows writing /tmp and the HOME cache dirs", () => {
    const p = buildPolicy({ HOME: home }, true);
    expect(p.writableExtra).toContain(realpathSync("/tmp"));
    expect(p.writableExtra).toContain(join(home, ".npm"));
    expect(p.writableExtra).toContain(join(home, ".cache"));
    expect(p.writableExtra).toContain(join(home, ".bun"));
    expect(p.writableExtra).toContain(join(home, ".cargo"));
  });

  it("adds TMPDIR when set and distinct from /tmp", () => {
    expect(buildPolicy({ HOME: home, TMPDIR: "/var/tmpx" }, true).writableExtra).toContain(
      "/var/tmpx",
    );
    // not duplicated when it equals /tmp
    const canonicalTmp = realpathSync("/tmp");
    const dup = buildPolicy({ HOME: home, TMPDIR: "/tmp" }, true).writableExtra.filter(
      (w) => w === canonicalTmp,
    );
    expect(dup.length).toBe(1);
  });

  it("blocks secret dirs and secret files under HOME", () => {
    const p = buildPolicy({ HOME: home }, true);
    expect(p.blockedDirs).toContain(join(home, ".ssh"));
    expect(p.blockedDirs).toContain(join(home, ".aws"));
    expect(p.blockedDirs).toContain(join(home, ".config/gcloud"));
    expect(p.blockedFiles).toContain(join(home, ".netrc"));
  });

  it("passes the network flag through and tolerates a missing HOME", () => {
    expect(buildPolicy({ HOME: home }, false).network).toBe(false);
    const noHome = buildPolicy({}, true);
    expect(noHome.blockedDirs).toEqual([]);
    expect(noHome.blockedFiles).toEqual([]);
    expect(noHome.writableExtra).toContain(realpathSync("/tmp"));
  });
});

describe("buildPolicy canonicalization", () => {
  it("canonicalizes a symlinked TMPDIR to its real path", () => {
    const realDir = mkdtempSync(join(tmpdir(), "cleetus-real-"));
    const link = `${realDir}-link`;
    symlinkSync(realDir, link);
    try {
      const p = buildPolicy({ HOME: "/home/u", TMPDIR: link }, true);
      expect(p.writableExtra).toContain(realpathSync(realDir));
      expect(p.writableExtra).not.toContain(link);
    } finally {
      rmSync(link);
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  it("keeps a non-existent path as its literal form", () => {
    const p = buildPolicy({ HOME: "/home/u" }, true);
    expect(p.writableExtra).toContain("/home/u/.cargo");
  });

  it("de-duplicates inputs that resolve to the same canonical path", () => {
    const link = join(tmpdir(), `cleetus-tmplink-${process.pid}`);
    symlinkSync("/tmp", link);
    try {
      const p = buildPolicy({ HOME: "/home/u", TMPDIR: link }, true);
      const canonicalTmp = realpathSync("/tmp");
      expect(p.writableExtra.filter((w) => w === canonicalTmp)).toHaveLength(1);
    } finally {
      rmSync(link);
    }
  });

  it("canonicalizes a symlinked blocked secret dir", () => {
    const home = mkdtempSync(join(tmpdir(), "cleetus-home-"));
    const realSsh = mkdtempSync(join(tmpdir(), "cleetus-ssh-"));
    symlinkSync(realSsh, join(home, ".ssh"));
    try {
      const p = buildPolicy({ HOME: home }, true);
      expect(p.blockedDirs).toContain(realpathSync(join(home, ".ssh")));
    } finally {
      rmSync(join(home, ".ssh"));
      rmSync(home, { recursive: true, force: true });
      rmSync(realSsh, { recursive: true, force: true });
    }
  });
});
