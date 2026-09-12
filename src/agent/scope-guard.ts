import { basename, extname, normalize } from "node:path";

/**
 * Words dropped from a task title before matching: articles/prepositions/conjunctions, generic
 * build-verbs, structural nouns (with plurals — a file lives under `pages/`, so the singular alone
 * would leave `pages` distinctive), and common directory/scaffolding tokens (path segments collide
 * across most files). Biased large on purpose: more stopwords ⇒ fewer distinctive tokens ⇒ fewer
 * blocks ⇒ safer. This is the guard's one tuning surface (design §4.4).
 */
const STOPWORDS = new Set<string>([
  // articles / prepositions / conjunctions
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "for",
  "with",
  "into",
  "in",
  "on",
  "at",
  "by",
  "from",
  "as",
  "its",
  "it",
  "is",
  // generic build-verbs
  "build",
  "add",
  "create",
  "make",
  "implement",
  "wire",
  "set",
  "setup",
  "configure",
  "install",
  "init",
  "initialize",
  "update",
  "refactor",
  "fix",
  "support",
  "handle",
  "enable",
  "use",
  "write",
  "define",
  // structural nouns + plurals
  "page",
  "pages",
  "component",
  "components",
  "route",
  "routes",
  "routing",
  "view",
  "views",
  "file",
  "files",
  "module",
  "modules",
  "feature",
  "features",
  "test",
  "tests",
  "app",
  "apps",
  "main",
  "index",
  "base",
  "deps",
  "dependency",
  "dependencies",
  // common directory / scaffolding tokens
  "src",
  "lib",
  "libs",
  "util",
  "utils",
  "helper",
  "helpers",
  "hook",
  "hooks",
  "type",
  "types",
  "style",
  "styles",
  "asset",
  "assets",
  "config",
  "configs",
  "common",
  "shared",
  "core",
]);

/** Split a camelCase / PascalCase / kebab / snake / dotted run into lowercase words. */
function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase boundary
    .split(/[^a-zA-Z0-9]+/) // non-alphanumeric runs
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

/** Distinctive tokens of a task title: lowercased words ≥3 chars that are not stopwords. Pure. */
export function distinctiveTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of splitWords(title)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** Tokens of a write path: the basename stem plus each directory segment, camel/kebab/snake-split. */
export function pathTokens(path: string): Set<string> {
  const stem = basename(path, extname(path));
  const dirPart = path.slice(0, path.length - basename(path).length);
  const out = new Set<string>();
  for (const w of splitWords(stem)) out.add(w);
  for (const w of splitWords(dirPart)) out.add(w);
  return out;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

export interface ScopeCreepInput {
  path: string;
  currentTitle: string;
  pendingTitles: string[];
}

export interface ScopeCreepDecision {
  blocked: boolean;
  matchedTitle?: string;
}

/**
 * Verification/review tasks inspect the integrated result; they do not own implementation paths.
 * Letting their broad titles participate in path matching makes names such as "Verify the alt TUI
 * skin" steal `skin.ts`, `AltApp.tsx`, and the exact tests from the workers assigned to create
 * them. Keep this intentionally anchored to the first verb so an implementation task that merely
 * mentions later verification still participates normally.
 */
export function isVerificationOnlyTitle(title: string): boolean {
  return /^(?:(?:retry|recovery|final)\s*:?\s+)*(?:verify|verification|validate|validation|review|audit|smoke(?:-?test)?|check)\b/i.test(
    title.trim(),
  );
}

/**
 * Decide whether a brand-new worker `write_file` belongs to a still-pending task. Conservative: the
 * current task always wins a tie (a path matching this worker's own title is never blocked), and
 * matching is whole-token, never substring. Pure.
 */
export function scopeCreepBlock(input: ScopeCreepInput): ScopeCreepDecision {
  const pTokens = pathTokens(input.path);
  if (pTokens.size === 0) return { blocked: false };
  // Current task wins: a file matching this worker's own task is never blocked.
  if (intersects(distinctiveTokens(input.currentTitle), pTokens)) return { blocked: false };
  for (const title of input.pendingTitles) {
    if (isVerificationOnlyTitle(title)) continue;
    if (intersects(distinctiveTokens(title), pTokens)) {
      return { blocked: true, matchedTitle: title };
    }
  }
  return { blocked: false };
}

/** Guidance pushed as the blocked write's tool result: steer the worker back to its own scope. */
export function scopeBlockMessage(
  path: string,
  matchedTitle: string,
  currentTitle: string,
): string {
  return `\`${path}\` looks like it belongs to an upcoming task ("${matchedTitle}"), not your task. Skip it — a later task will create it. Focus only on your task: ${currentTitle}.`;
}

const PROTECTED_INFRASTRUCTURE = [
  /^(?:package\.json|bun\.lockb?|tsconfig(?:\.[^/]+)?\.json|biome\.json)$/i,
  /^scripts\/build\.[cm]?[jt]s$/i,
  /^\.github\/workflows\//i,
] as const;

function projectPath(path: string): string {
  return normalize(path).replace(/^\.\//, "").replaceAll("\\", "/");
}

/** Cleetus control state and repository metadata are never model-editable. They are managed by
 * Cleetus/Git-specific code paths, not generic file tools. */
export function protectedControlPath(path: string): boolean {
  const normalized = projectPath(path);
  return /^(?:\.cleetus|\.git)(?:\/|$)/i.test(normalized);
}

export function protectedControlPathMessage(path: string): string {
  return `\`${path}\` is protected control metadata. Cleetus will not let model-authored file tools modify .cleetus or .git; use the dedicated session, checkpoint, and Git commands instead.`;
}

function ownsPath(path: string, ownedPaths: string[]): boolean {
  const normalized = projectPath(path);
  const owned = new Set(ownedPaths.map(projectPath));
  if (owned.has(normalized)) return true;
  // A task explicitly assigned the package manifest necessarily owns its Bun lockfile too.
  return /^bun\.lockb?$/i.test(normalized) && owned.has("package.json");
}

export function protectedInfrastructureBlock(input: {
  path: string;
  ownedPaths: string[];
}): boolean {
  if (input.ownedPaths.length === 0 || ownsPath(input.path, input.ownedPaths)) return false;
  return PROTECTED_INFRASTRUCTURE.some((pattern) => pattern.test(projectPath(input.path)));
}

/** Package-manager mutations can change package.json and the lockfile through bash rather than a
 * structured edit tool. Restrict those commands when a focused worker has explicit file ownership
 * that does not include the manifest. Read-only `bun pm` and verification commands remain valid. */
export function protectedPackageCommandBlock(input: {
  command: string;
  ownedPaths: string[];
}): boolean {
  if (input.ownedPaths.length === 0 || ownsPath("package.json", input.ownedPaths)) return false;
  return /(?:^|[;&|]\s*|\bcd\s+\S+\s+&&\s+)bun\s+(?:add|remove|update|install)\b/i.test(
    input.command,
  );
}

export function protectedScopeBlockMessage(path: string, currentTitle: string): string {
  return `\`${path}\` is protected project infrastructure and is not owned by this focused worker task. Do not alter package/build configuration to bypass a task failure. Stay within the files explicitly assigned to: ${currentTitle}.`;
}
