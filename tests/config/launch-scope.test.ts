import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type LaunchScopeIo,
  establishLaunchScope,
  resolveLaunchScope,
} from "../../src/config/launch-scope";

const base = {
  cwd: "/work/proj",
  home: "/home/tester",
  makeScratchDir: () => "/tmp/cleetus-scratch-XXXX",
};

describe("resolveLaunchScope", () => {
  test("project (neither flag) keeps cwd and project memory", () => {
    const s = resolveLaunchScope({ ...base, global: false, scratch: false });
    expect(s).toEqual({
      kind: "project",
      dir: "/work/proj",
      ephemeral: false,
      defaultMemoryScope: "project",
    });
  });

  test("global uses the configured workspace dir and global memory", () => {
    const s = resolveLaunchScope({
      ...base,
      global: true,
      scratch: false,
      globalWorkspaceDir: "/opt/cleetus-global",
    });
    expect(s).toEqual({
      kind: "global",
      dir: "/opt/cleetus-global",
      ephemeral: false,
      defaultMemoryScope: "global",
      label: "global",
    });
  });

  test("global defaults to ~/.cleetus when unset", () => {
    const s = resolveLaunchScope({ ...base, global: true, scratch: false });
    expect(s.dir).toBe(join("/home/tester", ".cleetus"));
  });

  test("global expands a leading ~/ and resolves a relative path against home", () => {
    expect(
      resolveLaunchScope({ ...base, global: true, scratch: false, globalWorkspaceDir: "~/notes" })
        .dir,
    ).toBe(join("/home/tester", "notes"));
    expect(
      resolveLaunchScope({ ...base, global: true, scratch: false, globalWorkspaceDir: "notes" })
        .dir,
    ).toBe(join("/home/tester", "notes"));
  });

  test("scratch uses the injected factory and is ephemeral, memory global", () => {
    const s = resolveLaunchScope({ ...base, global: false, scratch: true });
    expect(s).toEqual({
      kind: "scratch",
      dir: "/tmp/cleetus-scratch-XXXX",
      ephemeral: true,
      defaultMemoryScope: "global",
      label: "scratch",
    });
  });

  test("both flags is an error", () => {
    expect(() => resolveLaunchScope({ ...base, global: true, scratch: true })).toThrow(
      /choose one of --global \/ --scratch/,
    );
  });

  test("global + --project-dir is an error", () => {
    expect(() =>
      resolveLaunchScope({ ...base, global: true, scratch: false, projectHome: "/x" }),
    ).toThrow(/--project-dir conflicts/);
  });
});

describe("establishLaunchScope", () => {
  function spyIo() {
    const calls = {
      chdir: [] as string[],
      mkdirp: [] as string[],
      cleanup: [] as string[],
      reap: 0,
    };
    const io: LaunchScopeIo = {
      chdir: (d) => calls.chdir.push(d),
      mkdirp: (d) => calls.mkdirp.push(d),
      registerCleanup: (d) => calls.cleanup.push(d),
      reapStale: () => {
        calls.reap += 1;
      },
    };
    return { io, calls };
  }

  test("project: reaps, never chdirs or registers cleanup", () => {
    const { io, calls } = spyIo();
    establishLaunchScope({ ...base, global: false, scratch: false }, io);
    expect(calls.reap).toBe(1);
    expect(calls.chdir).toEqual([]);
    expect(calls.mkdirp).toEqual([]);
    expect(calls.cleanup).toEqual([]);
  });

  test("global: mkdir + chdir into the workspace, no cleanup", () => {
    const { io, calls } = spyIo();
    establishLaunchScope({ ...base, global: true, scratch: false, globalWorkspaceDir: "/g" }, io);
    expect(calls.mkdirp).toEqual(["/g"]);
    expect(calls.chdir).toEqual(["/g"]);
    expect(calls.cleanup).toEqual([]);
  });

  test("scratch: mkdir + chdir + registers cleanup for the temp dir", () => {
    const { io, calls } = spyIo();
    establishLaunchScope({ ...base, global: false, scratch: true }, io);
    expect(calls.chdir).toEqual(["/tmp/cleetus-scratch-XXXX"]);
    expect(calls.cleanup).toEqual(["/tmp/cleetus-scratch-XXXX"]);
  });
});
