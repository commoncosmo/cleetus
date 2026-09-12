import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathEscapesProject, rawToolPath } from "./path-guard";

export interface MalformedPathHit {
  /** The reconstructed in-project path the model almost certainly meant. */
  suggestion: string;
}

/** The path-bearing argument for the guard, across ALL path tools. Reuses rawToolPath for
 *  the write set (write_file/edit_file/multi_edit/apply_patch); adds read_file (`path`) and
 *  glob (`cwd`). `glob.pattern` is a glob expression, not a path, so it is excluded. */
export function extractGuardedPath(tool: string, args: unknown): string | null {
  const w = rawToolPath(tool, args);
  if (w) return w;
  if (tool === "read_file") return strArg(args, "path");
  if (tool === "glob") return strArg(args, "cwd");
  return null;
}

function strArg(args: unknown, key: string): string | null {
  const v = (args as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function realStatDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * High-precision detection of a corrupted form of an in-project path. Returns a suggested
 * correction, or null when the path is clean-in-project, a legitimate out-of-tree path, or
 * too ambiguous to repair (caller falls through to existing behaviour). `statDir` is
 * injected for testability.
 */
export async function detectMalformedProjectPath(
  rawPath: string,
  projectDir: string,
  statDir: (dir: string) => Promise<boolean> = realStatDir,
): Promise<MalformedPathHit | null> {
  // (A) Escape gate: clean in-project paths are never touched.
  if (!(await pathEscapesProject(rawPath, projectDir))) return null;

  const projectRoot = resolve(projectDir);
  const base = basename(projectRoot);
  const rawLower = rawPath.toLowerCase();
  const embeddedRootSignal = rawPath.indexOf(projectRoot) > 0;
  const segments = rawPath.split("/").filter((s) => s.length > 0);

  // (B) Recover the longest trailing segment-run whose parent dir exists under the root.
  for (let k = segments.length - 1; k >= 1; k--) {
    const tailSegs = segments.slice(segments.length - k);
    if (tailSegs.includes("..")) continue;
    const tail = tailSegs.join("/");
    const candidate = join(projectRoot, tail);
    // Stay inside the project (defends against any residual climb).
    if (candidate !== projectRoot && !candidate.startsWith(projectRoot + sep)) continue;
    if (!(await statDir(dirname(candidate)))) continue;

    // (C) Anchor: "<base>/<tail>" appears in the raw path (case-insensitive) — the model
    // named THIS project, then corrupted the route to it. Rejects same-named siblings
    // ("sample-app-backup/src/...") whose segment is not exactly <base>.
    if (!rawLower.includes(`${base}/${tail}`.toLowerCase())) continue;

    // (D) Corruption signature, tightened to avoid false positives on legitimate spacey
    // external paths: either the absolute root is embedded later in the string, OR the
    // segment that carries the matched <base> is itself noise-corrupted (space/tab/|) AND
    // everything before that segment is exactly the project root's parent dir. Anchoring the
    // noise to the base segment + parent dir is what separates a corrupted root
    // ("…/north/f sample-app/…") from a legit external dir that merely routes through a
    // same-named folder ("~/Google Drive/<base>/…", whose <base> segment is clean). A
    // corrupted ancestor segment ABOVE the basename ("…/north/n | north/sample-app/…") is
    // deliberately NOT caught — it falls through to the normal out-of-tree prompt rather than
    // risk a false correction.
    const baseSegIdx = segments.length - k - 1;
    const baseSeg = baseSegIdx >= 0 ? (segments[baseSegIdx] ?? "") : "";
    const baseSegHasNoise = /[ \t|]/.test(baseSeg);
    const parentPrefix = isAbsolute(rawPath)
      ? `/${segments.slice(0, baseSegIdx).join("/")}`
      : segments.slice(0, baseSegIdx).join("/");
    const dirnameMatch = parentPrefix === dirname(projectRoot);
    if (!embeddedRootSignal && !(baseSegHasNoise && dirnameMatch)) continue;

    // No-op guard: a suggestion identical to the resolved raw path is not a hit.
    const resolvedRaw = isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectRoot, rawPath);
    if (candidate === resolvedRaw) continue;

    return { suggestion: candidate };
  }
  return null;
}

/** Runtime entry point: extract the tool's path, then run the pure core. */
export async function detectMalformedToolPath(
  tool: string,
  args: unknown,
  projectDir: string,
  statDir: (dir: string) => Promise<boolean> = realStatDir,
): Promise<MalformedPathHit | null> {
  const raw = extractGuardedPath(tool, args);
  if (!raw) return null;
  // A leading slash on an otherwise valid project-relative read is a common model typo
  // (`/src/App.tsx` after previously using `src/App.tsx`). Keep this deliberately read-only:
  // an absolute write may be an intentional request to create a new external location. Refuse
  // the typo before permission handling only when the absolute parent does not exist while the
  // reconstructed in-project parent does.
  if (tool === "read_file" && isAbsolute(raw) && !raw.slice(1).split("/").includes("..")) {
    const candidate = join(resolve(projectDir), raw.slice(1));
    if (!(await statDir(dirname(raw))) && (await statDir(dirname(candidate)))) {
      return { suggestion: candidate };
    }
  }
  return detectMalformedProjectPath(raw, projectDir, statDir);
}
