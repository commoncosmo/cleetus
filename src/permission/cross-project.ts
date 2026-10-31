import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isPathWithin } from "../lib/paths";
import { extractGuardedPath } from "./malformed-path";

export interface CrossProjectReference {
  rawPath: string;
  projectRoot: string;
}

function stringArg(args: unknown, key: string): string | null {
  const value = (args as Record<string, unknown> | null)?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Extract path-looking shell tokens without attempting to parse shell syntax. This is
 * deliberately conservative: only absolute paths and explicit ./ or ../ paths can identify a
 * sibling project. Ordinary command arguments and flags are ignored. */
function shellPathCandidates(command: string): string[] {
  const candidates: string[] = [];
  const token =
    process.platform === "win32"
      ? /(?:^|[\s"'`])((?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])[^\s"'`|;&<>]+)/g
      : /(?:^|[\s"'`])((?:\/|\.{1,2}\/)[^\s"'`|;&<>]+)/g;
  for (const match of command.matchAll(token)) {
    const raw = match[1]?.replace(/[),:\]}]+$/, "");
    if (raw) candidates.push(raw);
  }
  return candidates;
}

export function crossProjectPathCandidates(tool: string, args: unknown): string[] {
  const candidates = new Set<string>();
  const guarded = extractGuardedPath(tool, args);
  if (guarded) candidates.add(guarded);
  if (tool === "grep") {
    const path = stringArg(args, "path");
    if (path) candidates.add(path);
  }
  if (tool === "bash") {
    const cwd = stringArg(args, "cwd");
    if (cwd) candidates.add(cwd);
    const command = stringArg(args, "command");
    if (command) {
      for (const candidate of shellPathCandidates(command)) candidates.add(candidate);
    }
  }
  return [...candidates];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function containingCleetusProject(path: string): Promise<string | null> {
  let current = path;
  if (!(await isDirectory(current))) current = dirname(current);
  while (true) {
    if (await isDirectory(resolve(current, ".cleetus"))) return resolve(current);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function pathMentionedByUser(rawPath: string, projectRoot: string, userInput: string): boolean {
  const normalized = userInput.replaceAll("\\", "/");
  const raw = rawPath.replaceAll("\\", "/").replace(/\/+$/, "");
  const root = projectRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const text = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const rootText = process.platform === "win32" ? root.toLowerCase() : root;
  const rawText = process.platform === "win32" ? raw.toLowerCase() : raw;
  return text.includes(rootText) || (raw.length > 2 && text.includes(rawText));
}

/** Detect a model-generated reference into another Cleetus project. Explicit paths named in the
 * user's current request remain eligible for the normal permission flow. */
export async function unexpectedCleetusProjectReference(
  tool: string,
  args: unknown,
  projectDir: string,
  userInput: string,
): Promise<CrossProjectReference | null> {
  const activeRoot = resolve(projectDir);
  for (const rawPath of crossProjectPathCandidates(tool, args)) {
    const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(activeRoot, rawPath);
    const siblingRoot = await containingCleetusProject(target);
    if (
      siblingRoot &&
      !isPathWithin(activeRoot, siblingRoot) &&
      !pathMentionedByUser(rawPath, siblingRoot, userInput)
    ) {
      return { rawPath, projectRoot: siblingRoot };
    }
  }
  return null;
}
