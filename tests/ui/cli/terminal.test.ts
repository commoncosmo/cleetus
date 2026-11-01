import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { establishLaunchScope } from "../../../src/config/launch-scope";
import { parseEditorWords } from "../../../src/editor/words";
import { runTerminal } from "../../../src/ui/cli/terminal";
import {
  currentCleetusLaunch,
  findWindowsTerminal,
  installTerminalProfile,
  terminalFragmentPath,
  terminalOpenArgs,
  terminalProfile,
  uninstallTerminalProfile,
} from "../../../src/windows/terminal";

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cleetus-terminal-")));
  roots.push(root);
  const executable = join(root, "Cleetus's Ω.exe");
  writeFileSync(executable, "fixture");
  return { root, launch: { executable, args: [] as string[] } };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(realpathSync(tmpdir()) + sep))
      throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile install/update/uninstall affects only the app-owned fragment", () => {
  const { root, launch } = fixture();
  const path = installTerminalProfile(launch, root);
  const sibling = join(dirname(path), "user.txt");
  writeFileSync(sibling, "keep");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(terminalProfile(launch));
  expect(terminalProfile(launch).profiles[0]?.startingDirectory).toBe("%USERPROFILE%");
  expect(terminalProfile(launch).profiles[0]?.commandline).toBe(
    `"${launch.executable}" "--global"`,
  );
  const updated = { executable: process.execPath, args: [join(root, "entry script.ts")] };
  expect(installTerminalProfile(updated, root)).toBe(path);
  expect(JSON.parse(readFileSync(path, "utf8")).profiles[0].commandline).toBe(
    `"${updated.executable}" "${join(root, "entry script.ts")}" "--global"`,
  );
  expect(uninstallTerminalProfile(root)).toBe(path);
  expect(existsSync(path)).toBe(false);
  expect(readFileSync(sibling, "utf8")).toBe("keep");
  expect(uninstallTerminalProfile(root)).toBeNull();
});

test("unowned/extended fragments, linked parents and hardlinks are preserved", () => {
  const { root, launch } = fixture();
  const path = terminalFragmentPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const foreign = '{"profiles":[{"name":"User profile"}]}';
  writeFileSync(path, foreign);
  expect(() => installTerminalProfile(launch, root)).toThrow("not owned");
  expect(() => uninstallTerminalProfile(root)).toThrow("not owned");
  expect(readFileSync(path, "utf8")).toBe(foreign);
  writeFileSync(path, JSON.stringify({ ...terminalProfile(launch), schemes: [{ name: "User" }] }));
  expect(() => uninstallTerminalProfile(root)).toThrow("not owned");
  writeFileSync(
    path,
    JSON.stringify({
      ...terminalProfile(launch),
      profiles: [{ ...terminalProfile(launch).profiles[0], font: { face: "User font" } }],
    }),
  );
  expect(() => installTerminalProfile(launch, root)).toThrow("not owned");
  const alias = join(root, "alias");
  const destination = join(root, "destination");
  mkdirSync(destination);
  symlinkSync(destination, alias, process.platform === "win32" ? "junction" : "dir");
  expect(() => installTerminalProfile(launch, alias)).toThrow("linked");
  writeFileSync(path, JSON.stringify(terminalProfile(launch)));
  const copy = join(root, "linked.json");
  linkSync(path, copy);
  expect(() => installTerminalProfile(launch, root)).toThrow("linked");
  expect(() => uninstallTerminalProfile(root)).toThrow("linked");
  expect(readFileSync(copy, "utf8")).toContain("Cleetus");
});

test("source launches retain Bun and the entry point; compiled launches use the binary", () => {
  const { root, launch } = fixture();
  const entry = join(root, "src", "cleetus.ts");
  expect(currentCleetusLaunch(join(root, "bun.exe"), entry)).toEqual({
    executable: join(root, "bun.exe"),
    args: [entry],
  });
  expect(currentCleetusLaunch(launch.executable, entry)).toEqual(launch);
});

test("dropdown launch selects managed global workspace even when inherited cwd is System32", () => {
  const { root, launch } = fixture();
  const profile = terminalProfile(launch).profiles[0]!;
  const argv = parseEditorWords(profile.commandline, "win32");
  const system32 = join(root, "Windows", "system32");
  const local = join(root, "local");
  const created: string[] = [];
  const changed: string[] = [];
  const scope = establishLaunchScope(
    {
      global: argv.includes("--global"),
      scratch: false,
      cwd: system32,
      home: root,
      userPathOptions: {
        platform: "win32",
        env: { LOCALAPPDATA: local, CLEETUS_PORTABLE: "0" },
        exists: () => false,
        populated: () => false,
      },
    },
    {
      mkdirp: (path) => {
        created.push(path);
      },
      chdir: (path) => {
        changed.push(path);
      },
      reapStale: () => {},
      registerCleanup: () => {},
    },
  );
  expect(scope.kind).toBe("global");
  expect(created).toEqual([join(local, "Cleetus", "workspace")]);
  expect(changed).toEqual(created);
  expect(created).not.toContain(join(system32, ".cleetus"));
});

test("open sends native argv for tabs/panes and refuses wt action delimiters", () => {
  const { root, launch } = fixture();
  const calls: { executable: string; args: string[] }[] = [];
  const output: string[] = [];
  const io = {
    platform: "win32" as const,
    launch,
    which: () => "wt.exe",
    packages: () => [],
    write: (s: string) => {
      output.push(s);
    },
    writeErr: (s: string) => {
      output.push(s);
    },
    run: (executable: string, args: string[]) => {
      calls.push({ executable, args });
    },
  };
  const project = join(root, "project's Ω folder");
  mkdirSync(project);
  expect(runTerminal(["bun", "cleetus", "terminal", "open", project], root, io)).toBe(0);
  expect(calls[0]).toEqual({ executable: "wt.exe", args: terminalOpenArgs(project, launch) });
  expect(calls[0]!.args).toContain(project);
  expect(calls[0]!.args.at(-1)).toBe(launch.executable);
  expect(calls[0]!.args).not.toContain("--global");
  expect(runTerminal(["bun", "cleetus", "terminal", "open", "--split"], project, io)).toBe(0);
  expect(calls[1]!.args[2]).toBe("split-pane");
  expect(calls[1]!.args).not.toContain("pwsh.exe");
  expect(() => terminalOpenArgs("C:\\project;split-pane", launch)).toThrow("semicolons");
  expect(() =>
    terminalOpenArgs("C:\\project", { executable: "C:\\bad;cmd.exe", args: [] }),
  ).toThrow("semicolons");
  expect(
    runTerminal(["bun", "cleetus", "terminal", "open"], root, { ...io, which: () => null }),
  ).toBe(1);
  expect(calls).toHaveLength(2);
});

test("Terminal discovery falls back from App Execution Aliases to installed packages", () => {
  const { root, launch } = fixture();
  expect(
    findWindowsTerminal(
      () => "on-path.exe",
      () => {
        throw new Error("not queried");
      },
    ),
  ).toBe("on-path.exe");
  expect(
    findWindowsTerminal(
      () => null,
      () => [join(root, "missing.exe"), launch.executable],
    ),
  ).toBe(launch.executable);
  expect(
    findWindowsTerminal(
      () => null,
      () => [],
    ),
  ).toBeNull();
});

test("open forwards split orientation and initial fraction as separate native arguments", () => {
  const { root, launch } = fixture();
  const calls: string[][] = [];
  const io = {
    platform: "win32" as const,
    launch,
    which: () => "wt.exe",
    write: () => {},
    writeErr: () => {},
    run: (_exe: string, args: string[]) => {
      calls.push(args);
    },
  };
  for (const [flags, orientation, fraction] of [
    [["--vertical", "--size", "0.65"], "-V", "0.65"],
    [["--horizontal", "--size", ".25"], "-H", "0.25"],
    [["--vertical"], "-V", undefined],
    [["--horizontal"], "-H", undefined],
    [["--size", "0.01"], undefined, "0.01"],
    [["--size", "0.99"], undefined, "0.99"],
  ] as const) {
    expect(
      runTerminal(["bun", "cleetus", "terminal", "open", root, "--split", ...flags], root, io),
    ).toBe(0);
    const args = calls.at(-1)!;
    expect(args[2]).toBe("split-pane");
    expect(args.includes("-V")).toBe(orientation === "-V");
    expect(args.includes("-H")).toBe(orientation === "-H");
    expect(args.includes("--size")).toBe(fraction !== undefined);
    if (fraction !== undefined) expect(args[args.indexOf("--size") + 1]).toBe(fraction);
    expect(args.slice(args.indexOf("--") + 1)).toEqual([launch.executable]);
    expect(args).toContain(root);
  }
  const automatic = terminalOpenArgs(root, launch, true);
  expect(automatic).not.toContain("-V");
  expect(automatic).not.toContain("-H");
  expect(automatic).not.toContain("--size");
});

test("invalid pane options fail before executable discovery or launch", () => {
  const { root, launch } = fixture();
  const messages: string[] = [];
  let discoveries = 0;
  let launches = 0;
  const io = {
    platform: "win32" as const,
    launch,
    which: () => {
      discoveries++;
      return "wt.exe";
    },
    write: () => {},
    writeErr: (s: string) => {
      messages.push(s);
    },
    run: () => {
      launches++;
    },
  };
  for (const flags of [
    ["--vertical"],
    ["--horizontal"],
    ["--size", "0.5"],
    ["--split", "--vertical", "--horizontal"],
    ["--split", "--size"],
    ...["0", "1", "-0.5", "0.009", "0.991", "65", "NaN", "Infinity", "0.5extra", "65%", ""].map(
      (size) => ["--split", "--size", size],
    ),
  ])
    expect(runTerminal(["bun", "cleetus", "terminal", "open", ...flags], root, io)).toBe(1);
  for (const action of ["install", "uninstall"]) {
    for (const flags of [
      ["--vertical"],
      ["--horizontal"],
      ["--size", "0.5"],
      ["--split", "--size", "0.5"],
    ])
      expect(runTerminal(["bun", "cleetus", "terminal", action, ...flags], root, io)).toBe(1);
  }
  expect(discoveries).toBe(0);
  expect(launches).toBe(0);
  expect(messages.join("\n")).toContain("require --split");
  expect(messages.join("\n")).toContain("not both");
  expect(messages.join("\n")).toContain("0.01 to 0.99");
  expect(() => terminalOpenArgs(root, launch, false, { size: 0.5 })).toThrow("require --split");
  expect(() => terminalOpenArgs(root, launch, true, { size: Number.NaN })).toThrow("0.01 to 0.99");
});

test("CLI installs in LOCALAPPDATA, validates usage and stays independent of providers", () => {
  const { root, launch } = fixture();
  const messages: string[] = [];
  const io = {
    platform: "win32" as const,
    launch,
    env: { LOCALAPPDATA: root },
    write: (s: string) => {
      messages.push(s);
    },
    writeErr: (s: string) => {
      messages.push(s);
    },
  };
  expect(runTerminal(["bun", "cleetus", "terminal", "install"], root, io)).toBe(0);
  expect(existsSync(terminalFragmentPath(root))).toBe(true);
  expect(runTerminal(["bun", "cleetus", "terminal", "uninstall"], root, io)).toBe(0);
  expect(
    runTerminal(["bun", "cleetus", "terminal", "--help"], root, { ...io, platform: "linux" }),
  ).toBe(0);
  expect(
    runTerminal(["bun", "cleetus", "terminal", "open"], root, { ...io, platform: "linux" }),
  ).toBe(1);
  for (const args of [
    ["install", "unexpected"],
    ["uninstall", "--split"],
    ["bogus"],
    ["open", "--bad-flag"],
  ])
    expect(runTerminal(["bun", "cleetus", "terminal", ...args], root, io)).toBe(1);
  expect(messages.join("\n")).toContain("native Windows");
});
