import { describe, expect, it } from "bun:test";
import { looksLikeWriteDenial, unconfinedSandboxNotice } from "../../src/sandbox/boundary";

describe("looksLikeWriteDenial", () => {
  it("matches EPERM (Seatbelt)", () => {
    expect(looksLikeWriteDenial("mkdir: /x: Operation not permitted")).toBe(true);
  });
  it("matches EACCES", () => {
    expect(looksLikeWriteDenial("touch: /x: Permission denied")).toBe(true);
  });
  it("matches EROFS (bwrap / read-only mount)", () => {
    expect(looksLikeWriteDenial("cannot create /x: Read-only file system")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(looksLikeWriteDenial("OPERATION NOT PERMITTED")).toBe(true);
  });
  it("does not match unrelated failures", () => {
    expect(looksLikeWriteDenial("bash: line 0: cd: /x: No such file or directory")).toBe(false);
    expect(looksLikeWriteDenial("exit 1")).toBe(false);
    expect(looksLikeWriteDenial("")).toBe(false);
  });
});

describe("unconfinedSandboxNotice", () => {
  it("returns the notice when writes are not confined", () => {
    expect(unconfinedSandboxNotice(null)).toBe(
      "sandbox backend does not confine writes; bash can write anywhere on the host.",
    );
  });
  it("returns null when writes are confined", () => {
    expect(unconfinedSandboxNotice("/proj")).toBeNull();
  });

  it("degraded notice names the concrete lost protections", () => {
    const text = unconfinedSandboxNotice(null, true)!;
    expect(text).toContain(".git");
    expect(text).toContain(".cleetus");
    expect(text).toContain("~/.ssh");
    expect(text).toMatch(/bwrap|docker/i);
  });

  it("degraded=false keeps the existing one-liner", () => {
    expect(unconfinedSandboxNotice(null, false)).toBe(
      "sandbox backend does not confine writes; bash can write anywhere on the host.",
    );
  });
});
