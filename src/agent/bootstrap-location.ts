import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionMode } from "../permission/modes";
import { isCodingTask } from "./coding-task";

/** Where a fresh bootstrap should be scaffolded. */
export type BootstrapLocation = { kind: "cwd" } | { kind: "subdir"; name: string };

/** Agent/VCS artifacts that don't count against "is this dir a fresh bootstrap target". */
export const BOOTSTRAP_IGNORE = new Set([
  ".cleetus",
  ".git",
  ".DS_Store",
  ".remember",
  ".superpowers",
]);

/** True when `entries` (a dir's top-level names) contain nothing but ignorable artifacts — the
 *  dir is empty from a scaffolder's view but non-empty because of `.cleetus`. Pure. */
export function isFreshBootstrap(entries: string[]): boolean {
  return entries.every((e) => BOOTSTRAP_IGNORE.has(e));
}

/** True when a plain (non-plan, non-orchestrate) turn should first ask cwd-vs-subdirectory: a
 *  normal-mode imperative coding request against a fresh-bootstrap dir. `isCodingTask` (not the
 *  narrower `isExplicitBuild`, which misses real multi-stack prompts) accepts the request; the
 *  fresh-dir guard is what makes an imperative coding request a bootstrap. Pure. */
export function shouldPromptBootstrapLocation(input: {
  mode: PermissionMode;
  text: string;
  entries: string[];
}): boolean {
  return input.mode === "normal" && isCodingTask(input.text) && isFreshBootstrap(input.entries);
}

/** Derive a filesystem-safe subdirectory name from the request: prefer a quoted `named "X"`
 *  token, else the first slug-able word, else `app`. Pure. */
export function suggestSubdirName(request: string): string {
  const named = request.match(/named\s+["'`]?([A-Za-z0-9][\w-]*)/i);
  const raw = named?.[1];
  const slug = (raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return slug.length > 0 ? slug : "app";
}

/** The location grounding injected into structuring, replan, and worker prompts. Pure. */
export function renderLocationAnchor(
  location: BootstrapLocation,
  projectDir: string,
  opts?: { scaffold?: boolean },
): string {
  const scaffold = opts?.scaffold ?? true;
  if (location.kind === "subdir") {
    const dir = `${projectDir}/${location.name}`;
    const base = `Create and build the project inside the subdirectory:\n${dir}\nEvery task operates inside it, using paths relative to it.`;
    return scaffold ? `${base} Use the \`scaffold\` tool for the initial create-* command.` : base;
  }
  const base = `Build the project directly in the current working directory:\n${projectDir}\nDo NOT create a subdirectory for the project.`;
  return scaffold
    ? `${base} For any create-* / scaffolding command use the \`scaffold\` tool (it handles the non-empty-cwd case) rather than running the command directly.`
    : base;
}

/** Append the bootstrap location grounding to a turn's text as a <system-reminder>, so a
 *  single-agent (non-orchestrated) turn is grounded exactly like an orchestration worker.
 *  Callers pass a location only when one was chosen; otherwise they leave the text untouched.
 *  Pure. */
export function appendLocationAnchor(
  text: string,
  location: BootstrapLocation,
  projectDir: string,
): string {
  const anchor = renderLocationAnchor(location, projectDir);
  return `${text}\n\n<system-reminder>\n${anchor}\n</system-reminder>`;
}

/** Top-level names that mark an already-scaffolded project. */
const MARKERS = [
  "package.json",
  "src",
  "index.html",
  "node_modules",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
];

/** Subdirs that never count as a candidate project root, on top of BOOTSTRAP_IGNORE. */
const EXCLUDED_SUBDIRS = new Set(["node_modules", "dist"]);

/** The project-marker names present directly in a directory listing (exact MARKERS membership
 *  plus the vite.config.* / tsconfig*.json patterns). Pure. */
export function projectMarkersIn(entries: string[]): string[] {
  return entries.filter(
    (e) => MARKERS.includes(e) || /^vite\.config\./.test(e) || /^tsconfig.*\.json$/.test(e),
  );
}

/** Where a project already lives, derived from disk. */
export type ProjectLocation =
  | { at: "cwd"; markers: string[] }
  | { at: "subdir"; candidates: { name: string; markers: string[] }[] }
  | { at: "none" };

/** Pure decision core. `rootEntries` = the project dir's top-level names; `subdirMarkers` = for
 *  each candidate immediate subdir, the marker names found directly inside it. Root markers win
 *  (a populated root IS the project); else any subdirs holding markers are candidates; else none. */
export function locateProject(
  rootEntries: string[],
  subdirMarkers: Record<string, string[]>,
): ProjectLocation {
  const rootMarkers = projectMarkersIn(rootEntries);
  if (rootMarkers.length > 0) return { at: "cwd", markers: rootMarkers };
  const candidates = Object.entries(subdirMarkers)
    .filter(([, markers]) => markers.length > 0)
    .map(([name, markers]) => ({ name, markers }));
  if (candidates.length > 0) return { at: "subdir", candidates };
  return { at: "none" };
}

/** Read the project root, then each CANDIDATE immediate subdir (a directory not in
 *  BOOTSTRAP_IGNORE or EXCLUDED_SUBDIRS), collecting the markers directly inside it, and decide
 *  where the project lives. Read errors are tolerated: a failed subdir read = no markers; a failed
 *  root read = { at: "none" }. */
export async function scanProject(projectDir: string): Promise<ProjectLocation> {
  let rootEntries: string[];
  try {
    rootEntries = await readdir(projectDir);
  } catch {
    return { at: "none" };
  }
  // Excluded/ignored names (node_modules, dist, .cleetus, .git, …) never make the ROOT read as a
  // project, nor are they candidate subdirs.
  const relevantRoot = rootEntries.filter(
    (e) => !BOOTSTRAP_IGNORE.has(e) && !EXCLUDED_SUBDIRS.has(e),
  );
  const rootMarkers = projectMarkersIn(relevantRoot);
  if (rootMarkers.length > 0) return { at: "cwd", markers: rootMarkers };
  const subdirMarkers: Record<string, string[]> = {};
  for (const name of relevantRoot) {
    const full = join(projectDir, name);
    try {
      if (!(await stat(full)).isDirectory()) continue;
      subdirMarkers[name] = projectMarkersIn(await readdir(full));
    } catch {
      // unreadable entry (removed mid-scan, permission) → treat as no markers
    }
  }
  return locateProject(relevantRoot, subdirMarkers);
}

/** The follow-up-turn grounding reminder, wrapped as a <system-reminder>. Returns "" unless the
 *  project lives in a subdirectory — the case where the root listing is misleading and a model
 *  wrongly concludes nothing exists. cwd-located and fresh projects return "". Pure. */
export function locationGroundingReminder(location: ProjectLocation): string {
  if (location.at !== "subdir") return "";
  let body: string;
  if (location.candidates.length === 1) {
    const c = location.candidates[0]!;
    body = `The project already exists in ./${c.name} (contains: ${c.markers.join(", ")}). Work inside it, using paths relative to it. Do NOT re-scaffold or create a new project in the current directory.`;
  } else {
    const list = location.candidates.map((c) => `./${c.name}`).join(", ");
    body = `Projects already exist in ${list}. Work within the relevant existing project; do NOT re-scaffold or create a new project in the current directory.`;
  }
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

/** From a dir listing, summarize the present project markers so a replan knows work already
 *  landed. "" when the target has no markers (a genuinely empty target). Pure. */
export function snapshotProjectMarkers(entries: string[]): string {
  const present = projectMarkersIn(entries);
  if (present.length === 0) return "";
  return `The target already contains a scaffolded project (${present.join(", ")}) — do NOT re-scaffold; continue from the existing project.`;
}

/** The directory a bootstrap actually builds into: the subdir for a subdir bootstrap, else the
 *  project dir itself. Pure. */
export function resolveBuildDir(projectDir: string, location: BootstrapLocation): string {
  return location.kind === "subdir" ? `${projectDir}/${location.name}` : projectDir;
}

/** A deterministic one-line snapshot of what a build dir already contains, for grounding a worker
 *  so it does not re-scaffold. "" when the dir holds nothing but ignorable artifacts (fresh). Lists
 *  top-level entries minus BOOTSTRAP_IGNORE members. Pure. */
export function describeOnDisk(entries: string[]): string {
  const names = entries.filter((e) => !BOOTSTRAP_IGNORE.has(e));
  if (names.length === 0) return "";
  return `The project already exists on disk. It contains: ${names.join(", ")}`;
}
