import type { Checkpoint, FileSnapshot, RestorationStep } from "./types";

/**
 * Given the chronological slice of checkpoints being undone (oldest → newest),
 * compute the fs operations that restore the pre-turn state. For each touched
 * path the EARLIEST snapshot wins — that is the file's content at the start of
 * the first undone turn, i.e. exactly what we are reverting to. A snapshot of a
 * created file becomes a delete; otherwise the pre-turn content is written back.
 */
export function resolveRestoration(checkpoints: Checkpoint[]): RestorationStep[] {
  const earliest = new Map<string, FileSnapshot>();
  for (const cp of checkpoints) {
    for (const snap of cp.files.values()) {
      if (!earliest.has(snap.path)) earliest.set(snap.path, snap);
    }
  }
  const steps: RestorationStep[] = [];
  for (const snap of earliest.values()) {
    if (snap.created) steps.push({ path: snap.path, action: "delete" });
    else steps.push({ path: snap.path, action: "write", content: snap.before });
  }
  return steps;
}
