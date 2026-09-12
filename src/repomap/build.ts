import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { enumerateFiles } from "../codeindex/enumerate";
import { loadCache, saveCache } from "./cache";
import { extractSymbols } from "./extract";
import { rankFiles } from "./rank";
import { renderMap } from "./render";
import type { FileSymbols, RepoMapCache, RepoSymbol } from "./types";

function sha256(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export interface BuildRepoMapOptions {
  projectDir: string;
  tokenBudget: number;
  /** Defaults to <projectDir>/.cleetus/repomap.json */
  cachePath?: string;
}

export async function buildRepoMap(opts: BuildRepoMapOptions): Promise<string> {
  const cachePath = opts.cachePath ?? join(opts.projectDir, ".cleetus", "repomap.json");
  try {
    const files = await enumerateFiles(opts.projectDir);
    const cache = await loadCache(cachePath);
    const next: RepoMapCache = {}; // rebuilt from present files → deletions pruned
    const fileSymbols: FileSymbols[] = [];
    for (const rel of files) {
      let content: string;
      try {
        content = await readFile(join(opts.projectDir, rel), "utf8");
      } catch {
        continue; // vanished/unreadable mid-run
      }
      const hash = sha256(content);
      const prev = cache[rel];
      let symbols: RepoSymbol[];
      if (prev && prev.hash === hash) {
        symbols = prev.symbols;
      } else {
        try {
          symbols = extractSymbols(rel, content);
        } catch {
          symbols = []; // bad file lists name only, never crashes the build
        }
      }
      next[rel] = { hash, symbols };
      fileSymbols.push({ path: rel, symbols });
    }
    await saveCache(cachePath, next);
    return renderMap(rankFiles(fileSymbols), opts.tokenBudget);
  } catch (e) {
    console.error(`[cleetus] WARNING: repo-map build failed: ${(e as Error).message}`);
    return ""; // graceful: session continues mapless
  }
}
