import { describe, expect, it } from "bun:test";
import {
  SECRET_DIRS,
  SECRET_FILES,
  isSecretPath,
  secretDirPaths,
  secretFilePaths,
} from "../../src/security/secret-paths";

describe("secret-paths", () => {
  const HOME = "/home/u";

  it("exposes the canonical home-relative lists", () => {
    expect(SECRET_DIRS).toEqual([".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker"]);
    expect(SECRET_FILES).toEqual([".netrc"]);
  });

  it("expands against a home dir", () => {
    expect(secretDirPaths(HOME)).toContain("/home/u/.ssh");
    expect(secretFilePaths(HOME)).toEqual(["/home/u/.netrc"]);
  });

  it("empty home expands to nothing", () => {
    expect(secretDirPaths("")).toEqual([]);
    expect(secretFilePaths("")).toEqual([]);
  });

  it("flags paths inside a secret dir, the dir itself, and secret files", () => {
    expect(isSecretPath("/home/u/.ssh/id_rsa", HOME)).toBe(true);
    expect(isSecretPath("/home/u/.ssh", HOME)).toBe(true);
    expect(isSecretPath("/home/u/.config/gcloud/credentials.db", HOME)).toBe(true);
    expect(isSecretPath("/home/u/.netrc", HOME)).toBe(true);
  });

  it("does not flag lookalikes or ordinary paths", () => {
    expect(isSecretPath("/home/u/.sshx/notes", HOME)).toBe(false);
    expect(isSecretPath("/home/u/project/src/app.ts", HOME)).toBe(false);
    expect(isSecretPath("/home/u/.netrc.bak", HOME)).toBe(false);
    expect(isSecretPath("/home/u/.ssh/id_rsa", "")).toBe(false);
  });
});
