import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SpawnEditor, editorEnvironment, launchEditor } from "../../src/editor/launch";

describe("launchEditor", () => {
  test("prefers EDITOR and falls back to VISUAL only when EDITOR is unset", async () => {
    const calls: string[][] = [];
    const common = {
      cwd: "/work/project",
      args: "",
      exists: () => true,
      realpath: (path: string) => path,
      spawn: (argv: string[]) => {
        calls.push(argv);
        return { exited: Promise.resolve(0) };
      },
    };

    await launchEditor({
      ...common,
      env: { EDITOR: "vim -f", VISUAL: "code --wait" },
    });
    await launchEditor({
      ...common,
      env: { EDITOR: "   ", VISUAL: "code --wait" },
    });
    await launchEditor({
      ...common,
      env: { VISUAL: "nvim" },
    });

    expect(calls).toEqual([
      ["vim", "-f", "/work/project"],
      ["code", "--wait", "/work/project"],
      ["nvim", "/work/project"],
    ]);
  });

  test("uses cwd by default and preserves configured editor arguments", async () => {
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    const spawn: SpawnEditor = (argv, options) => {
      calls.push({ argv, cwd: options.cwd });
      return { exited: Promise.resolve(0) };
    };

    const result = await launchEditor({
      cwd: "/work/project",
      args: "",
      editor: "code --wait",
      exists: (path) => path === "/work/project",
      realpath: (path) => path,
      spawn,
    });

    expect(result.targets).toEqual(["/work/project"]);
    expect(calls).toEqual([{ argv: ["code", "--wait", "/work/project"], cwd: "/work/project" }]);
  });

  test("resolves multiple quoted paths and strips the argument separator", async () => {
    let argv: string[] = [];
    await launchEditor({
      cwd: "/work/project",
      args: `-- "docs/with spaces" /tmp/other`,
      confirmOutsideProject: true,
      authorizeOutsideProject: async () => true,
      editor: `"/Applications/Editor App/bin/editor" --foreground`,
      exists: () => true,
      realpath: (path) => path,
      spawn: (next) => {
        argv = next;
        return { exited: Promise.resolve(0) };
      },
    });

    expect(argv).toEqual([
      "/Applications/Editor App/bin/editor",
      "--foreground",
      "/work/project/docs/with spaces",
      "/tmp/other",
    ]);
  });

  test("accepts feature-resolved targets without serializing them through command text", async () => {
    const calls: string[][] = [];
    await launchEditor({
      cwd: "/work/project",
      targets: ["/work/project/path with spaces"],
      editor: "vim",
      exists: () => true,
      spawn: (argv) => {
        calls.push(argv);
        return { exited: Promise.resolve(0) };
      },
    });

    expect(calls).toEqual([["vim", "/work/project/path with spaces"]]);
  });

  test("creates one empty project file before opening it", async () => {
    const project = mkdtempSync(join(tmpdir(), "cleetus-editor-launch-create-"));
    try {
      const calls: string[][] = [];
      const result = await launchEditor({
        cwd: project,
        args: '"notes/new file.md"',
        create: true,
        editor: "vim",
        spawn: (argv) => {
          calls.push(argv);
          return { exited: Promise.resolve(0) };
        },
      });

      const target = join(project, "notes", "new file.md");
      expect(result.targets).toEqual([target]);
      expect(calls).toEqual([["vim", target]]);
      expect(readFileSync(target, "utf8")).toBe("");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("creation is single-target, project-only, and non-overwriting", async () => {
    const project = mkdtempSync(join(tmpdir(), "cleetus-editor-launch-create-"));
    try {
      const existing = join(project, "existing.md");
      writeFileSync(existing, "original");
      const common = {
        cwd: project,
        create: true,
        editor: "vim",
        spawn: () => ({ exited: Promise.resolve(0) }),
      };

      await expect(launchEditor({ ...common, args: "one.md two.md" })).rejects.toThrow(
        "exactly one",
      );
      await expect(launchEditor({ ...common, args: "existing.md" })).rejects.toThrow(
        "already exists",
      );
      await expect(launchEditor({ ...common, args: "../outside.md" })).rejects.toThrow(
        "inside the project",
      );
      await expect(
        launchEditor({
          ...common,
          args: "new.md",
          confirmOutsideProject: true,
        }),
      ).rejects.toThrow("cannot be combined");

      expect(readFileSync(existing, "utf8")).toBe("original");
      expect(existsSync(join(project, "one.md"))).toBe(false);
      expect(existsSync(join(project, "new.md"))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("rejects mixing raw arguments with resolved targets", async () => {
    expect(
      launchEditor({
        cwd: "/work/project",
        args: "README.md",
        targets: ["/work/project/README.md"],
        editor: "vim",
      }),
    ).rejects.toThrow("cannot combine raw arguments with resolved targets");
  });

  test("reports unset configuration, missing targets, launch failures, and nonzero exits", async () => {
    await expect(
      launchEditor({
        cwd: "/work",
        args: "",
        editor: null,
        exists: () => true,
        spawn: () => ({ exited: Promise.resolve(0) }),
      }),
    ).rejects.toThrow("$EDITOR and $VISUAL are not set");

    await expect(
      launchEditor({
        cwd: "/work",
        args: "missing",
        editor: "vim",
        exists: () => false,
        spawn: () => ({ exited: Promise.resolve(0) }),
      }),
    ).rejects.toThrow("edit target does not exist: /work/missing");

    await expect(
      launchEditor({
        cwd: "/work",
        args: "",
        editor: "missing-editor",
        exists: () => true,
        realpath: (path) => path,
        spawn: () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow("could not launch editor 'missing-editor': ENOENT");

    await expect(
      launchEditor({
        cwd: "/work",
        args: "",
        editor: "vim",
        exists: () => true,
        realpath: (path) => path,
        spawn: () => ({ exited: Promise.resolve(7) }),
      }),
    ).rejects.toThrow("editor 'vim' exited with status 7");
  });

  test("removes its temporary SIGINT listener after success and failure", async () => {
    const before = process.listenerCount("SIGINT");
    await launchEditor({
      cwd: "/work",
      args: "",
      editor: "vim",
      exists: () => true,
      realpath: (path) => path,
      spawn: () => ({ exited: Promise.resolve(0) }),
    });
    expect(process.listenerCount("SIGINT")).toBe(before);

    await expect(
      launchEditor({
        cwd: "/work",
        args: "",
        editor: "vim",
        exists: () => true,
        realpath: (path) => path,
        spawn: () => ({ exited: Promise.resolve(1) }),
      }),
    ).rejects.toThrow();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test("blocks outside-project targets unless explicitly requested and confirmed", async () => {
    let spawned = false;
    await expect(
      launchEditor({
        cwd: "/work/project",
        args: "/outside/secret",
        editor: "vim",
        exists: () => true,
        realpath: (path) => path,
        spawn: () => {
          spawned = true;
          return { exited: Promise.resolve(0) };
        },
      }),
    ).rejects.toThrow("use /edit --outside-project");
    expect(spawned).toBe(false);

    const approvals: string[][] = [];
    await launchEditor({
      cwd: "/work/project",
      args: "/outside/secret",
      confirmOutsideProject: true,
      authorizeOutsideProject: async (request) => {
        approvals.push(request.targets);
        return true;
      },
      editor: "vim",
      exists: () => true,
      realpath: (path) => path,
      spawn: () => {
        spawned = true;
        return { exited: Promise.resolve(0) };
      },
    });
    expect(approvals).toEqual([["/outside/secret"]]);
    expect(spawned).toBe(true);
  });

  test("fails closed when outside-project authorization is denied or unavailable", async () => {
    const base = {
      cwd: "/work/project",
      args: "/outside/secret",
      confirmOutsideProject: true,
      editor: "vim",
      exists: () => true,
      realpath: (path: string) => path,
      spawn: () => ({ exited: Promise.resolve(0) }),
    };
    await expect(launchEditor(base)).rejects.toThrow("authorization is unavailable");
    await expect(
      launchEditor({
        ...base,
        authorizeOutsideProject: async () => false,
      }),
    ).rejects.toThrow("cancelled");
  });

  test("rejects shell-command interpreters and strips credential-like environment values", async () => {
    await expect(
      launchEditor({
        cwd: "/work",
        args: "",
        editor: "sh -c",
        exists: () => true,
        realpath: (path) => path,
      }),
    ).rejects.toThrow("not a shell command interpreter");

    await expect(
      launchEditor({
        cwd: "/work",
        args: "",
        env: { VISUAL: "bash -c" },
        exists: () => true,
        realpath: (path) => path,
      }),
    ).rejects.toThrow("$VISUAL must name an editor");

    expect(
      editorEnvironment({
        PATH: "/bin",
        TERM: "xterm",
        OPENAI_API_KEY: "secret",
        GITHUB_TOKEN: "secret",
        DATABASE_PASSWORD: "secret",
      }),
    ).toEqual({ PATH: "/bin", TERM: "xterm" });
  });
});
