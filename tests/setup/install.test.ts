import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installBinary, isOnPath, resignInPlace } from "../../scripts/install";

test("isOnPath detects directory membership in a PATH string", () => {
  expect(isOnPath("/home/u/.local/bin", "/usr/bin:/home/u/.local/bin")).toBe(true);
  expect(isOnPath("/home/u/.local/bin", "/usr/bin:/bin")).toBe(false);
  expect(isOnPath("/x", undefined)).toBe(false);
});

test("installBinary copies the binary into the target dir as executable", () => {
  const src = mkdtempSync(join(tmpdir(), "cleetus-bin-"));
  const srcBinary = join(src, "cleetus");
  writeFileSync(srcBinary, "#!/bin/sh\necho hi\n");
  const target = mkdtempSync(join(tmpdir(), "cleetus-target-"));
  const dest = installBinary(srcBinary, target);
  expect(dest).toBe(join(target, "cleetus"));
  expect(existsSync(dest)).toBe(true);
  expect(statSync(dest).mode & 0o100).toBe(0o100); // owner-executable
});

test("resignInPlace re-signs adhoc on macOS and returns true", () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const did = resignInPlace("/tmp/x/cleetus", "darwin", (cmd, args) => {
    calls.push({ cmd, args });
  });
  expect(did).toBe(true);
  expect(calls).toEqual([{ cmd: "codesign", args: ["--force", "--sign", "-", "/tmp/x/cleetus"] }]);
});

test("resignInPlace is a no-op off macOS", () => {
  let called = false;
  const did = resignInPlace("/tmp/x/cleetus", "linux", () => {
    called = true;
  });
  expect(did).toBe(false);
  expect(called).toBe(false);
});
