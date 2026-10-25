import { afterEach, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { normalizeWindowsResult, plainPowerShellOutput } from "../../src/sandbox/powershell-output";
import type { ExecOptions, ExecResult, Sandbox } from "../../src/sandbox/types";
import { destructiveCommandDecision } from "../../src/tools/destructive-command";
import { ScaffoldTool, viteScaffoldPlan } from "../../src/tools/scaffold";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("does not associate a nested deletion with a later project-root listing", () => {
  const project = "C:\\work\\ctest";
  const command =
    'Remove-Item -LiteralPath "C:\\work\\ctest\\ctest" -Recurse -Force; Get-ChildItem -LiteralPath "C:\\work\\ctest"';
  expect(
    destructiveCommandDecision({
      command,
      projectDir: project,
      projectAlreadyExists: true,
      shell: "powershell",
    }).blocked,
  ).toBe(false);
  expect(
    destructiveCommandDecision({
      command: `Get-ChildItem 'C:\\work\\ctest'; Remove-Item 'C:\\work\\ctest' -Recurse`,
      projectDir: project,
      projectAlreadyExists: true,
      shell: "powershell",
    }).blocked,
  ).toBe(true);
});
it("keeps root/metadata deletions blocked across pipelines and newlines", () => {
  for (const command of [
    "echo harmless; Remove-Item .git -Recurse",
    "echo harmless\nRemove-Item . -Recurse",
    "Get-ChildItem | ForEach-Object { Remove-Item .cleetus -Recurse }",
    "Get-Item .git | Remove-Item -Recurse",
    "Remove-Item .\\.git -Recurse",
    "Remove-Item .\\* -Recurse",
    "Remove-Item .\\src -Recurse",
  ])
    expect(
      destructiveCommandDecision({
        command,
        projectDir: "C:/work/app",
        projectAlreadyExists: true,
        shell: "powershell",
      }).blocked,
    ).toBe(true);
});
it("does not split a quoted path at its semicolon", () => {
  expect(
    destructiveCommandDecision({
      command: "Remove-Item 'child;folder'; Get-ChildItem 'C:/work/app'",
      projectDir: "C:/work/app",
      projectAlreadyExists: true,
      shell: "powershell",
    }).blocked,
  ).toBe(false);
});
it("decodes parser-error CLIXML and strips terminal controls", () => {
  const xml =
    '#< CLIXML\r\n<Objs><S S="Error">_x001B_[31mParserError: &lt;bad&gt;_x000D__x000A_</S></Objs>';
  expect(plainPowerShellOutput(xml)).toBe("ParserError: <bad>\r\n");
  expect(plainPowerShellOutput("\x1b[32mfile.txt\x1b[0m")).toBe("file.txt");
});
it("does not decode PowerShell escape sequences recursively", () => {
  expect(plainPowerShellOutput("#< CLIXML\n<Objs><S>_x005F_x0041_ &amp;lt;</S></Objs>")).toBe(
    "_x0041_ &lt;",
  );
});
it("qualifies misleading MSIX trailers only when workload output exists", () => {
  const trailer =
    "The target executable 'pwsh.exe' appears to be a packaged (MSIX) app. Uninstall the packaged version and install an unpackaged build.";
  const result: ExecResult = {
    stdout: "",
    stderr: `Unknown parameter 'la'\n${trailer}`,
    exitCode: 1,
    timedOut: false,
    cancelled: false,
  };
  const normalized = normalizeWindowsResult(result);
  expect(normalized.stderr).toContain("Unknown parameter 'la'");
  expect(normalized.stderr).not.toContain("Uninstall");
  expect(normalized.exitCode).toBe(1);
  expect(normalizeWindowsResult({ ...result, stderr: trailer }).stderr).toBe(trailer);
});
it("only plans recovery for simple Vite commands, preserving explicit versions", () => {
  expect(viteScaffoldPlan("bunx create-vite@9.3.1 . --template react-ts")?.fallback).toBe(
    "npx --yes create-vite@9.3.1 . --template react-ts --no-interactive --no-immediate",
  );
  expect(viteScaffoldPlan("bunx create-vite .; echo extra")).toBeNull();
  expect(viteScaffoldPlan("bunx create-other .")).toBeNull();
});

const result = (over: Partial<ExecResult> = {}): ExecResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  ...over,
});
class Generator implements Sandbox {
  readonly shell = "powershell" as const;
  calls: { command: string; opts: ExecOptions }[] = [];
  constructor(private readonly generate: (i: number, opts: ExecOptions) => Promise<ExecResult>) {}
  exec(command: string, opts: ExecOptions) {
    this.calls.push({ command, opts });
    return this.generate(this.calls.length, opts);
  }
  async dispose() {}
  writeRoot() {
    return null;
  }
}
async function context() {
  const projectDir = await mkdtemp(join(tmpdir(), "recovery-scaffold-"));
  roots.push(projectDir);
  await mkdir(join(projectDir, ".cleetus"));
  await writeFile(join(projectDir, ".cleetus/sentinel"), "preserved");
  return { projectDir, abortSignal: new AbortController().signal };
}
it("rejects zero-exit cancellation without merging generated files", async () => {
  const ctx = await context();
  const generator = new Generator(async (_i, opts) => {
    await writeFile(join(opts.cwd!, "package.json"), JSON.stringify({ name: basename(opts.cwd!) }));
    return result({ stdout: "Operation cancelled" });
  });
  const output = await new ScaffoldTool(generator).run({ command: "bunx create-vite ." }, ctx);
  expect(output.errorCode).toBe("SCAFFOLD_CANCELLED");
  expect(await Bun.file(join(ctx.projectDir, "package.json")).exists()).toBe(false);
  expect(generator.calls).toHaveLength(1);
});
it("rejects an empty zero-exit scaffold", async () => {
  const ctx = await context();
  const output = await new ScaffoldTool(new Generator(async () => result())).run(
    { command: "bunx create-vite ." },
    ctx,
  );
  expect(output.errorCode).toBe("SCAFFOLD_NO_OUTPUT");
});
it("keeps the target package name and npm selection instead of leaking scratch identity", async () => {
  const ctx = await context();
  const generator = new Generator(async (_i, opts) => {
    await writeFile(join(opts.cwd!, "package.json"), JSON.stringify({ name: basename(opts.cwd!) }));
    await writeFile(join(opts.cwd!, "vite.config.ts"), "export default {};");
    return result();
  });
  const output = await new ScaffoldTool(generator).run(
    { command: "npx --yes create-vite . --template react-ts" },
    ctx,
  );
  expect(output.ok).toBe(true);
  const pkg = await Bun.file(join(ctx.projectDir, "package.json")).json();
  expect(pkg.name).toBe(basename(ctx.projectDir).toLowerCase());
  expect(pkg.name).not.toStartWith("cleetus-scaffold-");
  expect(pkg.devEngines.packageManager.name).toBe("npm");
  expect(output.output).toContain("npm install -D tailwindcss @tailwindcss/vite");
});
it("performs exactly one temp-error recovery in a fresh directory", async () => {
  const ctx = await context();
  const generator = new Generator(async (i, opts) => {
    if (i === 1) {
      await writeFile(join(opts.cwd!, "partial.txt"), "must not merge");
      return result({
        exitCode: 1,
        stderr: "error: EBADF accessing temporary directory. set $BUN_TMPDIR or $BUN_INSTALL",
      });
    }
    await writeFile(join(opts.cwd!, "package.json"), "{}");
    return result();
  });
  const output = await new ScaffoldTool(generator).run(
    { command: "bunx create-vite@9.3.1 . --template react-ts" },
    ctx,
  );
  expect(output.ok).toBe(true);
  expect(output.output).toContain("Recovered a Bun");
  expect(output.output).toContain("Use npm consistently");
  expect(
    (await Bun.file(join(ctx.projectDir, "package.json")).json()).devEngines.packageManager.name,
  ).toBe("npm");
  expect(generator.calls).toHaveLength(2);
  expect(generator.calls[0]?.opts.cwd).not.toBe(generator.calls[1]?.opts.cwd);
  expect(generator.calls[1]?.command).toStartWith("npx --yes create-vite@9.3.1");
  expect(await Bun.file(join(ctx.projectDir, "partial.txt")).exists()).toBe(false);
  expect(await Bun.file(join(ctx.projectDir, ".cleetus/sentinel")).text()).toBe("preserved");
});
it("does not retry twice or switch a Bun-managed project to npm", async () => {
  for (const managed of [false, true]) {
    const ctx = await context();
    if (managed) await writeFile(join(ctx.projectDir, "bun.lock"), "");
    const generator = new Generator(async () =>
      result({ exitCode: 1, stderr: "error: EPERM accessing temporary directory" }),
    );
    const output = await new ScaffoldTool(generator).run({ command: "bunx create-vite ." }, ctx);
    expect(output.ok).toBe(false);
    expect(generator.calls).toHaveLength(managed ? 1 : 2);
  }
});
it("does not retry timeouts or cancellation", async () => {
  for (const over of [{ timedOut: true }, { cancelled: true }]) {
    const ctx = await context();
    const generator = new Generator(async () =>
      result({ ...over, exitCode: 1, stderr: "error: EBADF accessing temporary directory" }),
    );
    expect((await new ScaffoldTool(generator).run({ command: "bunx create-vite ." }, ctx)).ok).toBe(
      false,
    );
    expect(generator.calls).toHaveLength(1);
  }
});
it("preserves an explicit Bun packageManager even without a lockfile", async () => {
  const ctx = await context();
  await writeFile(
    join(ctx.projectDir, "package.json"),
    JSON.stringify({ packageManager: "bun@1.3.14" }),
  );
  const generator = new Generator(async () =>
    result({ exitCode: 1, stderr: "error: EBADF accessing temporary directory" }),
  );
  const output = await new ScaffoldTool(generator).run(
    { command: "bunx create-vite .", target: "child" },
    ctx,
  );
  expect(output.ok).toBe(false);
  expect(generator.calls).toHaveLength(1);
});
