import { stat } from "node:fs/promises";

/** True when a worker's write_file must be refused as a blind recreate of a prior task's file:
 *  the target exists on disk with content and this worker has not touched it this turn. Pure. */
export function blocksRecreate(input: {
  toolName: string;
  existsNonEmpty: boolean;
  touched: boolean;
}): boolean {
  return input.toolName === "write_file" && input.existsNonEmpty && !input.touched;
}

/** Guidance pushed as the blocked write's tool result. Steers the worker to read-then-edit
 *  instead of clobbering a file an earlier task authored. */
export function recreateBlockMessage(path: string): string {
  return `\`${path}\` already exists (built by an earlier task). Do not recreate it with \`write_file\`. Read the relevant existing sections, then use \`edit_file\`, \`multi_edit\`, or \`apply_patch\` for targeted changes. A prior \`read_file\` does not authorize a whole-file overwrite.`;
}

/** True when `absPath` is a regular file with size > 0. Tolerates ENOENT (and any stat error)
 *  as false, so a missing target reads as "safe to create". */
export async function pathExistsNonEmpty(absPath: string): Promise<boolean> {
  try {
    const s = await stat(absPath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}
