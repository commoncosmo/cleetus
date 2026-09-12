import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RepoMapCache } from "./types";

export async function loadCache(path: string): Promise<RepoMapCache> {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) return data as RepoMapCache;
    return {};
  } catch {
    return {}; // missing or malformed → empty cache (full re-extract)
  }
}

export async function saveCache(path: string, cache: RepoMapCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache));
}
