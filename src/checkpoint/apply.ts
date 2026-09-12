import { unlink, writeFile } from "node:fs/promises";
import type { RestorationStep } from "./types";

/** Perform the fs operations produced by resolveRestoration. Paths are absolute.
 *  A delete of an already-missing file is a no-op (not an error). */
export async function applyRestoration(steps: RestorationStep[]): Promise<void> {
  for (const step of steps) {
    if (step.action === "delete") {
      try {
        await unlink(step.path);
      } catch {
        // already gone — fine
      }
    } else {
      await writeFile(step.path, step.content);
    }
  }
}
