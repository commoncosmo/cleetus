import { describe, expect, test } from "bun:test";
import { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";

function registry() {
  return buildCommandRegistry({
    providers: new ProviderRegistry(),
    getActive: () => ({ provider: "none", model: "none" }),
    setActive() {},
    getPermissions: () => ({ project: [], global: [] }),
  });
}

describe("/edit", () => {
  test("passes raw path arguments to the interactive editor handoff", async () => {
    const calls: string[] = [];
    await registry()
      .get("edit")!
      .run('"workflow files" README.md', {
        cwd: "/work",
        print() {},
        openEditor: async (request) => {
          calls.push(request.args ?? "");
        },
      });

    expect(calls).toEqual(['"workflow files" README.md']);
  });

  test("allows no arguments so the launcher can default to cwd", async () => {
    const calls: string[] = [];
    await registry()
      .get("edit")!
      .run("", {
        cwd: "/work",
        print() {},
        openEditor: async (request) => {
          calls.push(request.args ?? "");
        },
      });

    expect(calls).toEqual([""]);
  });

  test("reports hosts that cannot release the terminal to an editor", async () => {
    expect(
      registry()
        .get("edit")!
        .run("", {
          cwd: "/work",
          print() {},
        }),
    ).rejects.toThrow("editor handoff is unavailable in this host");
  });

  test("requires and forwards the explicit outside-project authorization form", async () => {
    const calls: Array<{ args?: string; confirmOutsideProject?: boolean }> = [];
    await registry()
      .get("edit")!
      .run("--outside-project ~/.ssh/config", {
        cwd: "/work",
        print() {},
        openEditor: async (request) => {
          calls.push(request);
        },
      });

    expect(calls).toEqual([
      {
        args: "~/.ssh/config",
        confirmOutsideProject: true,
      },
    ]);
    expect(
      registry()
        .get("edit")!
        .run("--outside-project", {
          cwd: "/work",
          print() {},
          openEditor: async () => {},
        }),
    ).rejects.toThrow("usage");
  });

  test("forwards exclusive project file creation and rejects ambiguous forms", async () => {
    const calls: Array<{ args?: string; create?: boolean }> = [];
    await registry()
      .get("edit")!
      .run('--create "notes/new file.md"', {
        cwd: "/work",
        print() {},
        openEditor: async (request) => {
          calls.push(request);
        },
      });

    expect(calls).toEqual([
      {
        args: '"notes/new file.md"',
        create: true,
      },
    ]);
    await expect(
      registry()
        .get("edit")!
        .run("--create", {
          cwd: "/work",
          print() {},
          openEditor: async () => {},
        }),
    ).rejects.toThrow("usage");
    await expect(
      registry()
        .get("edit")!
        .run("--create --outside-project /tmp/new", {
          cwd: "/work",
          print() {},
          openEditor: async () => {},
        }),
    ).rejects.toThrow("cannot be combined");
    await expect(
      registry()
        .get("edit")!
        .run("--outside-project --create /tmp/new", {
          cwd: "/work",
          print() {},
          openEditor: async () => {},
        }),
    ).rejects.toThrow("cannot be combined");
  });
});
