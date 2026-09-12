import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult, Sandbox } from "../../src/sandbox/types";
import { ScaffoldTool, viteStylingHint } from "../../src/tools/scaffold";

/** A sandbox that also writes a vite.config.ts, so the Tailwind-v4 styling hint fires. */
class ViteFixtureSandbox implements Sandbox {
  async exec(_command: string, opts: ExecOptions): Promise<ExecResult> {
    const cwd = opts.cwd!;
    await writeFile(join(cwd, "package.json"), "{}");
    await writeFile(join(cwd, "vite.config.ts"), "export default {}");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "main.tsx"), "// x");
    return { stdout: "scaffolded", stderr: "", exitCode: 0, timedOut: false, cancelled: false };
  }
  async dispose() {}
  writeRoot() {
    return null;
  }
}

/** A sandbox whose exec writes fixture project files into the given cwd (the tool's temp dir). */
class FixtureSandbox implements Sandbox {
  constructor(private readonly root: string | null = null) {}
  async exec(_command: string, opts: ExecOptions): Promise<ExecResult> {
    const cwd = opts.cwd!;
    await writeFile(join(cwd, "package.json"), "{}");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "main.tsx"), "// x");
    return { stdout: "scaffolded", stderr: "", exitCode: 0, timedOut: false, cancelled: false };
  }
  async dispose() {}
  writeRoot() {
    return this.root;
  }
}

class NestedFixtureSandbox implements Sandbox {
  async exec(_command: string, opts: ExecOptions): Promise<ExecResult> {
    const nested = join(opts.cwd!, "stuff20");
    await mkdir(join(nested, ".git"), { recursive: true });
    await writeFile(join(nested, ".git", "HEAD"), "ref: refs/heads/main");
    await mkdir(join(nested, "src"), { recursive: true });
    await writeFile(join(nested, "package.json"), '{"name":"stuff20"}');
    await writeFile(join(nested, "src", "main.tsx"), "// nested");
    return { stdout: "scaffolded", stderr: "", exitCode: 0, timedOut: false, cancelled: false };
  }
  async dispose() {}
  writeRoot() {
    return null;
  }
}

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scaffold-test-"));
  await mkdir(join(dir, ".cleetus"), { recursive: true });
  await writeFile(join(dir, ".cleetus", "sessions.db"), "db"); // protected, must survive
  return dir;
}

test("scaffold runs in a temp dir and merges into the project dir, preserving .cleetus", async () => {
  const dir = await project();
  const tool = new ScaffoldTool(new FixtureSandbox());
  const res = await tool.run(
    { command: "bunx create-vite . --template react-ts" },
    { projectDir: dir, abortSignal: new AbortController().signal },
  );
  expect(res.ok).toBe(true);
  expect(
    await stat(join(dir, "package.json"))
      .then(() => true)
      .catch(() => false),
  ).toBe(true);
  expect(
    await stat(join(dir, "src", "main.tsx"))
      .then(() => true)
      .catch(() => false),
  ).toBe(true);
  // .cleetus preserved; no leftover scaffold-* temp dir under it
  expect(
    await stat(join(dir, ".cleetus", "sessions.db"))
      .then(() => true)
      .catch(() => false),
  ).toBe(true);
  const leftovers = (await readdir(join(dir, ".cleetus"))).filter((n) => n.startsWith("scaffold-"));
  expect(leftovers).toEqual([]);
});

test("scaffold flattens a single generated project and strips nested VCS metadata", async () => {
  const dir = await project();
  const tool = new ScaffoldTool(new NestedFixtureSandbox());
  const res = await tool.run(
    { command: "bunx shadcn@latest init -n stuff20" },
    { projectDir: dir, abortSignal: new AbortController().signal },
  );
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.output).toContain("Flattened generated project directory: stuff20/");
  expect(await Bun.file(join(dir, "package.json")).text()).toContain("stuff20");
  expect(await Bun.file(join(dir, "src", "main.tsx")).text()).toBe("// nested");
  expect(
    await stat(join(dir, "stuff20"))
      .then(() => true)
      .catch(() => false),
  ).toBe(false);
  expect(
    await stat(join(dir, ".git"))
      .then(() => true)
      .catch(() => false),
  ).toBe(false);
});

test("scaffold reports a collision instead of overwriting an existing file (explicit target)", async () => {
  const dir = await project();
  const sub = join(dir, "app");
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, "package.json"), '{"existing":true}');
  const tool = new ScaffoldTool(new FixtureSandbox());
  const res = await tool.run(
    { command: "bunx create-vite .", target: sub },
    { projectDir: dir, abortSignal: new AbortController().signal },
  );
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.output).toContain("package.json"); // reported as skipped
  expect(await Bun.file(join(sub, "package.json")).text()).toContain("existing"); // not overwritten
});

test("scaffold refuses a target that escapes the project write-root", async () => {
  const dir = await project();
  const tool = new ScaffoldTool(new FixtureSandbox(dir));
  const outside = join(dir, "..", "escape");
  const res = await tool.run(
    { command: "bunx create-vite . --template react-ts", target: outside },
    { projectDir: dir, abortSignal: new AbortController().signal },
  );
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.errorCode).toBe("OUT_OF_TREE");
  expect(
    await stat(outside)
      .then(() => true)
      .catch(() => false),
  ).toBe(false);
  // no scaffold temp dir was left behind under .cleetus either
  const leftovers = (await readdir(join(dir, ".cleetus"))).filter((n) => n.startsWith("scaffold-"));
  expect(leftovers).toEqual([]);
});

test("scaffold allows an in-project target (e.g. a subdirectory) even with a write-root set", async () => {
  const dir = await project();
  const tool = new ScaffoldTool(new FixtureSandbox(dir));
  const sub = join(dir, "sample-app");
  const res = await tool.run(
    { command: "bunx create-vite . --template react-ts", target: sub },
    { projectDir: dir, abortSignal: new AbortController().signal },
  );
  expect(res.ok).toBe(true);
  expect(
    await stat(join(sub, "package.json"))
      .then(() => true)
      .catch(() => false),
  ).toBe(true);
});

test("refuses a target-less scaffold when a subdir project already exists", async () => {
  const dir = await project();
  await mkdir(join(dir, "sample-app", "src"), { recursive: true });
  await writeFile(join(dir, "sample-app", "package.json"), "{}");
  const tool = new ScaffoldTool(new FixtureSandbox());
  const res = await tool.run(
    { command: "bunx create-vite . --template react-ts" },
    { projectDir: dir, abortSignal: new AbortController().signal },
  );
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.errorCode).toBe("SCAFFOLD_REFUSED");
    expect(res.errorMessage).toContain("./sample-app");
  }
  // the existing subdir project is untouched (no fresh root scaffold happened)
  expect(await Bun.file(join(dir, "sample-app", "package.json")).text()).toBe("{}");
  expect(
    await stat(join(dir, "package.json"))
      .then(() => true)
      .catch(() => false),
  ).toBe(false);
});

test("refuses a target-less scaffold when the current directory is already a project", async () => {
  const dir = await project();
  await writeFile(join(dir, "package.json"), '{"existing":true}');
  const tool = new ScaffoldTool(new FixtureSandbox());
  const res = await tool.run(
    { command: "bunx create-vite ." },
    { projectDir: dir, abortSignal: new AbortController().signal },
  );
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.errorCode).toBe("SCAFFOLD_REFUSED");
  expect(await Bun.file(join(dir, "package.json")).text()).toContain("existing"); // untouched
});

test("allows a target-less scaffold in a fresh project dir", async () => {
  const dir = await project(); // only .cleetus present → fresh
  const tool = new ScaffoldTool(new FixtureSandbox());
  const res = await tool.run(
    { command: "bunx create-vite . --template react-ts" },
    { projectDir: dir, abortSignal: new AbortController().signal },
  );
  expect(res.ok).toBe(true);
});

test("viteStylingHint fires only when a vite.config was scaffolded", () => {
  expect(viteStylingHint(["package.json", "vite.config.ts", "src"])).toContain("Tailwind v4");
  expect(viteStylingHint(["package.json", "vite.config.ts"])).toContain("@tailwindcss/vite");
  expect(viteStylingHint(["package.json", "vite.config.ts"])).toContain("expectStyled");
  expect(viteStylingHint(["package.json", "src"])).toBe("");
  expect(viteStylingHint([])).toBe("");
});

test("scaffolding a Vite project appends the Tailwind-v4 wiring hint to the output", async () => {
  const dir = await project();
  const tool = new ScaffoldTool(new ViteFixtureSandbox());
  const res = await tool.run(
    { command: "bunx create-vite . --template react-ts" },
    { projectDir: dir, abortSignal: new AbortController().signal },
  );
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.output).toContain("@tailwindcss/vite");
    expect(res.output).toContain("Do NOT use the v3 recipe");
    expect(res.output).toContain("cssMinify:false");
  }
});

test('refuses an explicit "." target when a project already exists', async () => {
  const dir = await project();
  await writeFile(join(dir, "package.json"), '{"existing":true}');
  const tool = new ScaffoldTool(new FixtureSandbox());
  const res = await tool.run(
    { command: "bunx create-vite .", target: "." },
    { projectDir: dir, abortSignal: new AbortController().signal },
  );
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.errorCode).toBe("SCAFFOLD_REFUSED");
  expect(await Bun.file(join(dir, "package.json")).text()).toContain("existing"); // untouched
});

test("refuses an explicit absolute-projectDir target when a subdir project exists", async () => {
  const dir = await project();
  await mkdir(join(dir, "sample-app", "src"), { recursive: true });
  await writeFile(join(dir, "sample-app", "package.json"), "{}");
  const tool = new ScaffoldTool(new FixtureSandbox());
  const res = await tool.run(
    { command: "bunx create-vite . --template react-ts", target: dir }, // absolute == projectDir
    { projectDir: dir, abortSignal: new AbortController().signal },
  );
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.errorCode).toBe("SCAFFOLD_REFUSED");
    expect(res.errorMessage).toContain("./sample-app");
  }
});
