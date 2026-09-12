import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { ulid } from "ulid";
import { scanProject } from "../agent/bootstrap-location";
import { dirEscapesProject } from "../permission/path-guard";
import { type Sandbox, SandboxUnavailableError } from "../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "./types";

interface Args {
  command: string;
  target?: string;
}

/** Names never merged out of the scaffold temp dir into the target. */
const PROTECTED = new Set([".cleetus", ".git"]);
const SCAFFOLD_TIMEOUT_MS = 300_000;

function targetOutsideMessage(writeRoot: string): string {
  return `scaffold target is outside the project sandbox; it must be within ${writeRoot}.`;
}

/** A one-time correct-wiring hint appended when a Vite project was scaffolded. Small local models
 * reach for the Tailwind v3 recipe (`tailwindcss init -p`, `postcss`+`autoprefixer`) on a v4 install,
 * which never compiles utilities — the page renders text but is completely unstyled, and text-only
 * verification hides it. The hint lands right after `create vite`, before that mistake is made. */
export function viteStylingHint(mergedNames: string[]): string {
  const scaffoldedVite = mergedNames.some((name) => /^vite\.config\./.test(name));
  if (!scaffoldedVite) return "";
  return (
    "\n\nIf you add Tailwind CSS: this is Tailwind v4 — the compiler is a build plugin. Run " +
    "`bun add @tailwindcss/vite` and add `tailwindcss()` to the `plugins` array in vite.config " +
    '(or `@tailwindcss/postcss` in a postcss config), then `@import "tailwindcss";` in your CSS. ' +
    "Do NOT use the v3 recipe (`tailwindcss init -p`, `postcss` + `autoprefixer`, `tailwindcss` as a " +
    "PostCSS plugin) and never mask a CSS build error with `cssMinify:false`. After wiring, verify " +
    "styles actually apply with render_check `expectStyled: true` — a rendered-text check alone will " +
    "pass on a completely unstyled page."
  );
}

export class ScaffoldTool implements Tool {
  name = "scaffold";
  mutates = true;
  description =
    "Bootstrap a project with a create-* command reliably even when the current directory is " +
    "non-empty (it contains .cleetus, which makes scaffolders refuse it). Provide a `command` " +
    "that targets the current directory with `.` (e.g. `bunx create-vite . --template react-ts`). " +
    "The command runs in a fresh empty temp directory and the result is merged into `target` " +
    "(default: the project directory). Use this instead of running create-* commands directly.";
  parameters = {
    type: "object",
    properties: {
      command: { type: "string" },
      target: { type: "string" },
    },
    required: ["command"],
  };

  constructor(private readonly sandbox: Sandbox) {}

  serialize(args: unknown): string {
    return (args as Args).command;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as Args;
    const target = a.target ?? ctx.projectDir;
    const writeRoot = this.sandbox.writeRoot();
    if (writeRoot != null && (await dirEscapesProject(target, writeRoot))) {
      return { ok: false, errorCode: "OUT_OF_TREE", errorMessage: targetOutsideMessage(writeRoot) };
    }
    // Re-scaffold guard: a target-less (or explicit-root) scaffold onto a dir that already holds a
    // project is almost always a confused re-scaffold (ctest item 1: it preceded `rm -rf sample-app`).
    // An explicit non-root target (a genuine second project) and a fresh dir are unaffected.
    const projectRoot = resolve(ctx.projectDir);
    const targetIsRoot = resolve(ctx.projectDir, a.target ?? ".") === projectRoot;
    if (targetIsRoot) {
      const loc = await scanProject(ctx.projectDir);
      if (loc.at === "cwd") {
        return {
          ok: false,
          errorCode: "SCAFFOLD_REFUSED",
          errorMessage: `the current directory already contains a scaffolded project (${loc.markers.join(", ")}); work on the existing project rather than re-scaffolding.`,
        };
      }
      if (loc.at === "subdir") {
        const where = loc.candidates.map((c) => `./${c.name} (${c.markers.join(", ")})`).join(", ");
        return {
          ok: false,
          errorCode: "SCAFFOLD_REFUSED",
          errorMessage: `a project already exists in ${where}; do not re-scaffold it. If you meant to work on it, edit its files directly. If you really intend a separate second project, pass an explicit \`target\`.`,
        };
      }
    }
    // Keep generator scratch state outside `.cleetus`: Bash executions protect that control
    // directory, and a broken generator must never share a tree with the audit/checkpoint store.
    const tmp = await mkdtemp(join(tmpdir(), `cleetus-scaffold-${ulid()}-`));
    try {
      let result: Awaited<ReturnType<Sandbox["exec"]>>;
      try {
        result = await this.sandbox.exec(a.command, {
          cwd: tmp,
          timeoutMs: SCAFFOLD_TIMEOUT_MS,
          signal: ctx.abortSignal,
        });
      } catch (e) {
        const msg = e instanceof SandboxUnavailableError ? e.message : (e as Error).message;
        return { ok: false, errorCode: "TOOL_FAILED", errorMessage: msg };
      }
      if (result.cancelled) {
        return { ok: false, errorCode: "TOOL_FAILED", errorMessage: "scaffold cancelled" };
      }
      if (result.exitCode !== 0) {
        const tail = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: `scaffold command failed (exit ${result.exitCode}):\n${tail}`,
        };
      }
      await mkdir(target, { recursive: true });
      let mergeRoot = tmp;
      let flattened = "";
      const generatedLocation = await scanProject(tmp);
      if (generatedLocation.at === "subdir" && generatedLocation.candidates.length === 1) {
        const candidate = generatedLocation.candidates[0]!;
        const visibleTopLevel = (await readdir(tmp)).filter((name) => !PROTECTED.has(name));
        if (visibleTopLevel.length === 1 && visibleTopLevel[0] === candidate.name) {
          mergeRoot = join(tmp, candidate.name);
          flattened = `\nFlattened generated project directory: ${candidate.name}/`;
        }
      }
      const merged: string[] = [];
      const collisions: string[] = [];
      for (const name of await readdir(mergeRoot)) {
        if (PROTECTED.has(name)) continue;
        const dest = join(target, name);
        const exists = await stat(dest)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          collisions.push(name);
          continue;
        }
        const source = join(mergeRoot, name);
        await cp(source, dest, {
          recursive: true,
          filter: (entry) =>
            !relative(source, entry)
              .split(sep)
              .some((part) => PROTECTED.has(part)),
        });
        merged.push(name);
      }
      const skipped = collisions.length
        ? `\nSkipped (already present): ${collisions.join(", ")}`
        : "";
      return {
        ok: true,
        output: `Scaffolded into ${target}: ${merged.join(", ") || "(nothing new)"}${flattened}${skipped}${viteStylingHint(merged)}`,
      };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
