import { isAbsolute, relative } from "node:path";

/** Best-effort path relative to projectDir for display. Absolute paths under the
 *  project are relativized; "./x" loses its prefix; anything else is returned as-is. */
export function toRelative(projectDir: string, file: string): string {
  if (isAbsolute(file)) {
    const rel = relative(projectDir, file);
    return rel.startsWith("..") ? file : rel;
  }
  return file.replace(/^\.\//, "");
}
