import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Create one empty editor target beneath the project root without overwriting
 * an existing entry or traversing a symlinked parent.
 */
export function createConfinedEditorTarget(input: {
  root: string;
  target: string;
  label?: string;
}): string {
  const label = input.label ?? "edit target";
  const lexicalRoot = resolve(input.root);
  const realRoot = realpathSync(lexicalRoot);
  const target = resolve(input.target);

  if (target === lexicalRoot || !inside(lexicalRoot, target)) {
    throw new Error(`${label} must be a file inside the project: ${target}`);
  }

  const parent = dirname(target);
  const parentRelative = relative(lexicalRoot, parent);
  let cursor = lexicalRoot;
  for (const segment of parentRelative ? parentRelative.split(sep) : []) {
    cursor = resolve(cursor, segment);
    if (existsSync(cursor)) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`${label} parent must not be a symlink: ${cursor}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`${label} parent is not a directory: ${cursor}`);
      }
    } else {
      mkdirSync(cursor);
    }
    const realCursor = realpathSync(cursor);
    if (!inside(realRoot, realCursor)) {
      throw new Error(`${label} parent resolves outside the project: ${realCursor}`);
    }
  }

  if (existsSync(target)) {
    throw new Error(`${label} already exists: ${target}; use /edit without --create`);
  }

  let descriptor: number;
  try {
    descriptor = openSync(target, "wx");
  } catch (error) {
    throw new Error(`could not create ${label}: ${(error as Error).message}`);
  }
  closeSync(descriptor);

  const created = realpathSync(target);
  if (!inside(realRoot, created)) {
    throw new Error(`${label} resolves outside the project after creation: ${created}`);
  }
  return target;
}
