import { readFile } from "node:fs/promises";
import { CleetusError } from "../lib/errors";

/** Read the configured `system_prompt_file` once at startup. Returns null when unset. A
 *  configured-but-unreadable file is a hard config error — a silent fallback to the built-in
 *  persona would mask a typo'd path. Never re-read mid-session: the system prompt must stay
 *  byte-stable for the whole session (KV prefix cache, audit F3/F8). */
export async function loadSystemPromptOverride(path: string | undefined): Promise<string | null> {
  if (path == null) return null;
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    throw new CleetusError("CONFIG_INVALID", `system_prompt_file not readable: ${path}`, {
      cause: e,
    });
  }
}
