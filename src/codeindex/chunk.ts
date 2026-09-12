import type { FileChunk } from "./types";

export const CHUNK_LINES = 40;
export const CHUNK_OVERLAP = 8;
const STEP = CHUNK_LINES - CHUNK_OVERLAP; // 32

export function chunkFile(relPath: string, content: string): FileChunk[] {
  if (content.trim().length === 0) return [];
  const lines = content.split("\n");
  // Drop trailing empty lines produced by final newline(s) so line counts are natural.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const chunks: FileChunk[] = [];
  let index = 0;
  for (let start = 0; start < lines.length; start += STEP) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    chunks.push({
      id: `${relPath}#${index}`,
      text: lines.slice(start, end).join("\n"),
      metadata: { path: relPath, startLine: start + 1, endLine: end },
    });
    index++;
    if (end === lines.length) break;
  }
  return chunks;
}
