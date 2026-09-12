import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { patchTargetPath } from "../tools/apply-patch/parse";
import { PATH_WRITING_TOOLS } from "./types";

/**
 * Walk up `dir` until we find an ancestor that exists on disk, realpath it,
 * then re-attach the remaining suffix. This handles cases where the target's
 * parent directory does not yet exist (e.g. nested new files), while still
 * resolving symlinks that are present in existing ancestors.
 */
export async function realpathWithMissingParents(dir: string): Promise<string> {
  let current = dir;
  const missing: string[] = [];

  // Peel off non-existent path segments from the bottom up.
  while (true) {
    try {
      const real = await realpath(current);
      // Re-attach the missing suffix (in original order).
      if (missing.length === 0) return real;
      return [real, ...missing].join(sep);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Reached filesystem root and nothing resolved — return as-is.
        return [current, ...missing].join(sep);
      }
      missing.unshift(current.slice(parent === sep ? sep.length : parent.length + sep.length));
      current = parent;
    }
  }
}

/** Resolve `rawPath` against `projectDir` (realpath'd, symlink-aware) and report whether
 *  the target lands outside the project root. */
export async function pathEscapesProject(rawPath: string, projectDir: string): Promise<boolean> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(projectDir);
  } catch {
    projectRoot = resolve(projectDir);
  }
  const target = isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath);
  const resolvedDir = await realpathWithMissingParents(dirname(target));
  return resolvedDir !== projectRoot && !resolvedDir.startsWith(projectRoot + sep);
}

/** Resolve `rawDir` against `projectDir` (realpath'd, symlink-aware) and report whether the
 *  directory itself lands outside the project root. Unlike pathEscapesProject — which checks a
 *  file's containing dir via dirname — this treats `rawDir` as the target directory, so passing
 *  the project root (or ".") is correctly in-tree. */
export async function dirEscapesProject(rawDir: string, projectDir: string): Promise<boolean> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(projectDir);
  } catch {
    projectRoot = resolve(projectDir);
  }
  const target = isAbsolute(rawDir) ? rawDir : resolve(projectRoot, rawDir);
  const resolvedDir = await realpathWithMissingParents(target);
  return resolvedDir !== projectRoot && !resolvedDir.startsWith(projectRoot + sep);
}

/** The raw (unresolved) target path a write tool would write to, or null for non-write
 *  tools / missing path. apply_patch's path is embedded in the patch; the others use `path`. */
export function rawToolPath(tool: string, args: unknown): string | null {
  // apply_patch is also in PATH_WRITING_TOOLS (so pathPrefix rules govern it), but its target
  // is embedded in the patch text rather than a `path` arg — hence the special case first.
  if (tool === "apply_patch") {
    const patch = (args as { patch?: unknown } | null)?.patch;
    return typeof patch === "string" ? patchTargetPath(patch) : null;
  }
  if (PATH_WRITING_TOOLS.has(tool)) {
    const raw = (args as { path?: unknown } | null)?.path;
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  }
  return null;
}

/** Resolve a write tool's target path (absolute, symlink-aware), or null when there is none. */
export async function resolveToolTargetPath(
  tool: string,
  args: unknown,
  projectDir: string,
): Promise<string | null> {
  const raw = rawToolPath(tool, args);
  if (raw == null) return null;
  let projectRoot: string;
  try {
    projectRoot = await realpath(projectDir);
  } catch {
    projectRoot = resolve(projectDir);
  }
  const target = isAbsolute(raw) ? raw : resolve(projectRoot, raw);
  return realpathWithMissingParents(target);
}

/**
 * Returns true when a write_file/edit_file/multi_edit/apply_patch call would write to a
 * path that escapes `projectDir` (via absolute path, ../ traversal, or a
 * symlinked parent directory). Used to force a permission prompt for
 * out-of-tree writes even when the tool is allowlisted or --fuckit is set.
 * The path comes from the `path` arg for the find-and-replace writers, or from the
 * embedded `*** Update/Add File:` line for apply_patch. Returns false for any
 * non-write tool or when no usable path is present.
 */
export async function writeEscapesProject(
  tool: string,
  args: unknown,
  projectDir: string,
): Promise<boolean> {
  const raw = rawToolPath(tool, args);
  if (raw == null) return false;
  return pathEscapesProject(raw, projectDir);
}

/** Split a glob pattern into its literal (wildcard-free) leading directory part and a flag for
 *  `..` segments appearing at-or-after the first wildcard segment. The literal prefix is what
 *  the pattern anchors to on disk — it must pass the same read guards as an explicit path; a
 *  `..` in the wildcard tail cannot be resolved statically, so callers refuse it outright. */
export function splitPatternPrefix(pattern: string): { prefix: string; tailHasDotDot: boolean } {
  const segments = pattern.split("/");
  const literal: string[] = [];
  let i = 0;
  for (; i < segments.length; i++) {
    const seg = segments[i]!;
    if (/[*?[{]/.test(seg)) break;
    // The final segment of a file-matching pattern is a filename, not a dir anchor — but a
    // literal filename is still part of the anchored path; keep it. Only wildcards stop us.
    literal.push(seg);
  }
  const tailHasDotDot = segments.slice(i).includes("..");
  return { prefix: literal.join("/"), tailHasDotDot };
}

/** The FS location a read tool will touch: read_file's `path`, glob's `cwd` + its pattern's
 *  literal prefix, grep's `path` + its file_pattern's literal prefix (each defaulting to the
 *  project root). Resolved absolute + symlink-aware. Null for non-read tools. `escapes` is true
 *  when the resolved target leaves the project root. */
export async function resolveReadTarget(
  tool: string,
  args: unknown,
  projectDir: string,
): Promise<{ target: string; escapes: boolean } | null> {
  // Non-read tools resolve to null — decide that BEFORE any filesystem access; this runs on
  // every ACP permission check, reads included or not.
  if (tool !== "read_file" && tool !== "glob" && tool !== "grep") return null;

  let raw: string | undefined;
  let projectRoot: string;
  try {
    projectRoot = await realpath(projectDir);
  } catch {
    projectRoot = resolve(projectDir);
  }
  const base = (rawBase: string | undefined): string =>
    rawBase == null || rawBase === ""
      ? projectRoot
      : isAbsolute(rawBase)
        ? rawBase
        : resolve(projectRoot, rawBase);

  if (tool === "read_file") {
    raw = (args as { path?: string } | null)?.path;
  } else if (tool === "glob") {
    const a = args as { cwd?: string; pattern?: string } | null;
    const { prefix } = splitPatternPrefix(a?.pattern ?? "");
    const cwdBase = base(a?.cwd);
    raw = prefix ? resolve(cwdBase, prefix) : cwdBase;
  } else {
    const a = args as { path?: string; filePattern?: string; file_pattern?: string } | null;
    const filePattern = a?.filePattern ?? a?.file_pattern;
    const pathBase = base(a?.path);
    if (filePattern) {
      const { prefix } = splitPatternPrefix(filePattern);
      raw = prefix ? resolve(pathBase, prefix) : pathBase;
    } else {
      raw = a?.path;
    }
  }
  const target =
    raw == null || raw === "" ? projectRoot : isAbsolute(raw) ? raw : resolve(projectRoot, raw);
  const real = await realpathWithMissingParents(target);
  return {
    target: real,
    escapes: real !== projectRoot && !real.startsWith(projectRoot + sep),
  };
}
