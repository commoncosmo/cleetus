import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ToolContext } from "./types";
import { refuseIfOutsideProject } from "./within-project";

/** Recheck just before I/O and refuse final-component link swaps atomically. */
export async function guardedWrite(
  path: string,
  content: string,
  ctx: ToolContext,
  exclusive = false,
): Promise<void> {
  const refusal = await refuseIfOutsideProject(path, ctx);
  if (refusal) throw new Error(refusal.errorMessage);
  const fd = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (exclusive ? constants.O_EXCL : constants.O_TRUNC),
  );
  try {
    await fd.writeFile(content);
  } finally {
    await fd.close();
  }
}
