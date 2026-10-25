import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSandboxRegistry } from "../../src/acp/sandbox-registry";
import type { Sandbox } from "../../src/sandbox/types";

test("canonical session projects have independent execution roots and are disposed once", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-sandboxes-"));
  const created: string[] = [];
  const disposed: string[] = [];
  const registry = new AcpSandboxRegistry(async (cwd) => {
    created.push(cwd);
    return {
      writeRoot: () => cwd,
      exec: async () => {
        throw Error("unused");
      },
      dispose: async () => {
        disposed.push(cwd);
      },
    } satisfies Sandbox;
  });
  try {
    await mkdir(join(root, "one"));
    await mkdir(join(root, "two"));
    await symlink(
      join(root, "one"),
      join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const one = await registry.get(join(root, "one"));
    expect(await registry.get(join(root, "alias"))).toBe(one);
    const two = await registry.get(join(root, "two"));
    expect(two).not.toBe(one);
    expect(one.writeRoot()).not.toBe(two.writeRoot());
    expect(created).toHaveLength(2);
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
  expect(disposed).toHaveLength(2);
});
