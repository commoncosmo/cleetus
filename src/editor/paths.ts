import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function realEditorRoot(root: string, label: string): string {
  if (!existsSync(root)) throw new Error(`${label} does not exist: ${root}`);
  return realpathSync(root);
}

/** Resolve an existing editor target and prove its real target remains under the real root. */
export function confinedEditorTarget(input: {
  root: string;
  target: string;
  label: string;
}): string {
  const root = realEditorRoot(input.root, `${input.label} root`);
  if (!existsSync(input.target)) {
    throw new Error(`${input.label} does not exist: ${input.target}`);
  }
  const target = realpathSync(input.target);
  if (!inside(root, target)) {
    throw new Error(`${input.label} resolves outside ${root}: ${target}`);
  }
  return target;
}

/** Validate the nearest existing parent before creating a feature-owned file. */
export function confineEditorCreation(input: {
  root: string;
  target: string;
  label: string;
}): void {
  const root = realEditorRoot(input.root, `${input.label} root`);
  if (existsSync(input.target)) {
    confinedEditorTarget(input);
    return;
  }
  let parent = dirname(resolve(input.target));
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const realParent = realpathSync(parent);
  if (!inside(root, realParent)) {
    throw new Error(`${input.label} parent resolves outside ${root}: ${realParent}`);
  }
}

/** Prove an authoritative project-owned root has not itself escaped through a symlink. */
export function confinedEditorRoot(input: {
  boundary: string;
  root: string;
  label: string;
}): string {
  const boundary = realEditorRoot(input.boundary, `${input.label} boundary`);
  const root = realEditorRoot(input.root, input.label);
  if (!inside(boundary, root)) {
    throw new Error(`${input.label} resolves outside ${boundary}: ${root}`);
  }
  return root;
}

/** Directory integrations expose the whole tree to an editor, so reject hidden symlink exits. */
export function confinedEditorTree(input: {
  root: string;
  target: string;
  label: string;
  maxEntries?: number;
}): string {
  const target = confinedEditorTarget(input);
  if (!lstatSync(target).isDirectory()) return target;
  const pending = [target];
  let visited = 0;
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      visited += 1;
      if (visited > (input.maxEntries ?? 10_000)) {
        throw new Error(`${input.label} is too large to verify safely before editing`);
      }
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`${input.label} contains a symlink and cannot be opened safely: ${path}`);
      }
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return target;
}
