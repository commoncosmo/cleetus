import type { FileSymbols } from "./types";

/**
 * Ordering for budget truncation: most public surface first.
 * 1. descending symbol count, 2. shallower path (fewer "/" segments),
 * 3. path lexicographic (stable, deterministic).
 */
export function rankFiles(files: FileSymbols[]): FileSymbols[] {
  return [...files].sort((a, b) => {
    if (b.symbols.length !== a.symbols.length) return b.symbols.length - a.symbols.length;
    const da = a.path.split("/").length;
    const db = b.path.split("/").length;
    if (da !== db) return da - db;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}
